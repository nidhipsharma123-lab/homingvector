// Homingvector site: contested-environment harness around the TurtleShield decision core.
//
// WHAT IS PRODUCT CODE AND WHAT IS NOT -- the whole point of this file.
//   PRODUCT (compiled unchanged from the TurtleShield repo at the sha in provenance.json):
//     task::CbbaAgent, task::TimeDiscountedScore, task::CheckEligibility   -- who does which task
//     health::DegradationLadder, health::PermissionsFor                    -- what a degraded node may do
//     health::QuorumPolicy                                                 -- what a small group may do
//     health::ClassifyPeer, health::MayReallocatePeerWork                  -- when a silent peer's work is taken
//     nav::SpoofDetector, nav::FuseCooperative                             -- spoof detection, peer-aided nav
//     the fixed-wing / rover / boat capability profiles (tests/task_fixtures.h)
//   HARNESS (this file, site-owned): vehicle motion, the radio model, the nav error model, the
//     terrain, and the adversary's actions. It decides nothing. Every decision the page shows is
//     returned by a product call above.
//
// Deterministic: all randomness comes from one xorshift64* stream seeded by sim_init(), never
// from <random> -- std distributions are implementation-defined and would make the same seed give
// a different run on a different standard library.
#include <cmath>
#include <cstdarg>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <string>
#include <vector>
#include <algorithm>

#include "core/task/cbba.h"
#include "core/task/score.h"
#include "core/task/task.h"
#include "core/health/degradation.h"
#include "core/health/failure_response.h"
#include "core/health/quorum_policy.h"
#include "core/nav/spoof_detector.h"
#include "tests/task_fixtures.h"

using namespace turtleshield;
namespace T = turtleshield::task;
namespace H = turtleshield::health;
namespace N = turtleshield::nav;

namespace {

// ---------------------------------------------------------------- deterministic rng
struct Rng {
  uint64_t s = 0x9E3779B97F4A7C15ull;
  void seed(uint64_t v) { s = v ? v * 0x2545F4914F6CDD1Dull + 1 : 0x9E3779B97F4A7C15ull; for (int i = 0; i < 8; ++i) next(); }
  uint64_t next() { s ^= s >> 12; s ^= s << 25; s ^= s >> 27; return s * 0x2545F4914F6CDD1Dull; }
  double u() { return (next() >> 11) * (1.0 / 9007199254740992.0); }      // [0,1)
  double n() { double a = u() + 1e-12, b = u(); return std::sqrt(-2 * std::log(a)) * std::cos(6.283185307179586 * b); }
};

constexpr double W = 3200, Hm = 2000;         // world metres, east x north
constexpr double SHORE = 1450;                // north of this is water
constexpr double DT = 0.5;                    // seconds per step
constexpr double LEASE_S = 20.0;              // a claim stays leased this long past last contact
constexpr int NV = 12;

enum Kind { FW = 0, UGV = 1, USV = 2 };
enum TaskState { OPEN = 0, CLAIMED = 1, DONE = 2 };

struct Rect { double x0, y0, x1, y1; bool in(double x, double y) const { return x >= x0 && x <= x1 && y >= y0 && y <= y1; } };

struct Vehicle {
  Kind kind; bool alive = true;
  double x, y, hd = 0;              // truth
  double ex = 0, ey = 0;            // nav error: belief = truth + error
  double sigma = 3;                 // 1-sigma the vehicle BELIEVES (m)
  NavSource src = NavSource::kGnss;
  double spoof_dx = 0, spoof_dy = 0;
  bool spoof_known = false;
  double ins_ex = 0, ins_ey = 0;     // inertial/odometry error: never pulled by GNSS
  int logged_rung = 0; double rung_since = 0;
  NavSource logged_src = NavSource::kGnss;
  double battery = 1.0;
  double orbit = 0;
  H::DegradationLadder ladder;
  H::QuorumPolicy quorum;
  N::SpoofDetector spoof;
  std::vector<double> heard;        // last time we heard each vehicle
  std::vector<int> path;            // task indices, visit order (from CBBA)
  double service_left = -1;
  int rung = 0, regime = 3;
};

struct Task_ { double x, y; bool water; TaskState st = OPEN; int owner = -1; double lease_until = 0; double lost_at = -1; int lost_from = -1; };

struct Sim {
  Rng rng; uint64_t seed = 1;
  double t = 0;
  std::vector<Vehicle> v;
  std::vector<Task_> tasks;
  std::vector<Rect> jams, spoofs;
  std::vector<std::pair<int,int>> severed;
  double bandwidth = 1.0;
  double next_alloc = 0;
  CapabilityProfile pf, pr, pb;
  T::TimeDiscountedScore score;
  std::string log;
  double last_realloc_s = -1;
  int rounds_last = 0; int outcome_last = 0;
  std::vector<uint8_t> link;        // NV*NV: 1 if a message crossed this step
  bool complete = false; double complete_at = -1;
} S;

double rangeOf(Kind k) { return k == FW ? 1500 : (k == UGV ? 700 : 950); }
const char* kname(Kind k) { return k == FW ? "AIR" : (k == UGV ? "GND" : "SEA"); }
std::string vname(int i) {
  char b[16]; if (i < 0 || i >= (int)S.v.size()) return "?"; const Vehicle& a = S.v[i];
  int n = 0; for (int j = 0; j <= i; ++j) if (S.v[j].kind == a.kind) ++n;
  std::snprintf(b, sizeof b, "%s-%02d", kname(a.kind), n); return b;
}
void logf(const char* fmt, ...) __attribute__((format(printf, 1, 2)));
void logf(const char* fmt, ...) {
  char b[256]; va_list ap; va_start(ap, fmt); std::vsnprintf(b, sizeof b, fmt, ap); va_end(ap);
  char tb[24]; int s = (int)S.t; std::snprintf(tb, sizeof tb, "T+%02d:%02d ", s / 60, s % 60);
  S.log += tb; S.log += b; S.log += '\n';
  if (S.log.size() > 16000) S.log.erase(0, S.log.size() - 12000);
}

std::vector<std::pair<std::string, std::string>> pending;   // (event text, vehicle names)
void group(const std::string& who, const std::string& what) {
  for (auto& p : pending) if (p.first == what) { p.second += " " + who; return; }
  pending.push_back({what, who});
}
void flushGroups() {
  for (auto& p : pending) {
    int n = 1; for (char ch : p.second) n += ch == ' ';
    if (n > 3) logf("%d vehicles  %s", n, p.first.c_str());
    else logf("%s  %s", p.second.c_str(), p.first.c_str());
  }
  pending.clear();
}

bool severed(int a, int b) { for (auto& p : S.severed) if ((p.first == a && p.second == b) || (p.first == b && p.second == a)) return true; return false; }
bool inAny(const std::vector<Rect>& rs, double x, double y) { for (auto& r : rs) if (r.in(x, y)) return true; return false; }

PositionBelief beliefOf(const Vehicle& a) {
  PositionBelief b(Eigen::Vector3d(a.x + a.ex, a.y + a.ey, 0), Eigen::Matrix3d::Identity() * (a.sigma * a.sigma));
  b.nav_source = a.src; b.stamp.quality = ClockQuality::kMeshSynced;
  return b;
}

void reset(uint64_t seed) {
  S = Sim(); pending.clear();
  S.seed = seed; S.rng.seed(seed);
  S.pf = turtleshield_test::FixtureFixedWing("fw");
  S.pr = turtleshield_test::FixtureRover("ugv");
  S.pb = turtleshield_test::FixtureBoat("usv");
  auto add = [](Kind k, double x, double y) { Vehicle a; a.kind = k; a.x = x; a.y = y; a.hd = S.rng.u() * 6.28; a.heard.assign(NV, -1e9); a.orbit = S.rng.u() * 6.28; S.v.push_back(a); };
  for (int i = 0; i < 6; ++i) add(FW, 260 + 60 * i + S.rng.n() * 20, 380 + 70 * (i % 3) + S.rng.n() * 20);
  for (int i = 0; i < 3; ++i) add(UGV, 300 + 90 * i, 620 + S.rng.n() * 15);
  for (int i = 0; i < 3; ++i) add(USV, 420 + 160 * i, 1620 + S.rng.n() * 15);
  // survey stations: land grid for air+ground, a water line for air+surface
  for (int r = 0; r < 4; ++r) for (int c = 0; c < 6; ++c) {
    Task_ k; k.x = 900 + c * 380 + S.rng.n() * 40; k.y = 260 + r * 290 + S.rng.n() * 40; k.water = false; S.tasks.push_back(k);
  }
  for (int c = 0; c < 6; ++c) { Task_ k; k.x = 900 + c * 380 + S.rng.n() * 40; k.y = 1700 + S.rng.n() * 60; k.water = true; S.tasks.push_back(k); }
  S.link.assign(NV * NV, 0);
  logf("MISSION START  %d vehicles  %zu survey stations  seed %llu", NV, S.tasks.size(), (unsigned long long)seed);
}

const CapabilityProfile* profileOf(Kind k) { return k == FW ? &S.pf : (k == UGV ? &S.pr : &S.pb); }

// ---------------------------------------------------------------- radio: one step of heartbeats
void radio() {
  std::fill(S.link.begin(), S.link.end(), 0);
  for (int i = 0; i < NV; ++i) {
    if (!S.v[i].alive) continue;
    for (int j = 0; j < NV; ++j) {
      if (i == j || !S.v[j].alive) continue;
      double d = std::hypot(S.v[i].x - S.v[j].x, S.v[i].y - S.v[j].y);
      if (d > std::min(rangeOf(S.v[i].kind), rangeOf(S.v[j].kind))) continue;
      if (severed(i, j)) continue;
      if (S.rng.u() >= S.bandwidth) continue;               // collapsed bandwidth drops traffic
      S.v[j].heard[i] = S.t; S.link[i * NV + j] = 1;
    }
  }
  // Messages are relayed hop by hop, as the product's gossip does: a peer reachable through the
  // mesh this step is heard, even out of direct radio range. Without this every spread-out fleet
  // reads as comms-degraded before anything has happened to it.
  std::vector<int> comp(NV, -1); int c = 0;
  for (int s = 0; s < NV; ++s) {
    if (!S.v[s].alive || comp[s] >= 0) continue;
    std::vector<int> st{s}; comp[s] = c;
    while (!st.empty()) { int a = st.back(); st.pop_back();
      for (int b = 0; b < NV; ++b) if (S.v[b].alive && comp[b] < 0 && (S.link[a * NV + b] || S.link[b * NV + a])) { comp[b] = c; st.push_back(b); } }
    ++c;
  }
  for (int i = 0; i < NV; ++i) for (int j = 0; j < NV; ++j)
    if (i != j && comp[i] >= 0 && comp[i] == comp[j]) S.v[j].heard[i] = S.t;
}

bool heardRecently(int j, int i, double within) { return S.t - S.v[j].heard[i] <= within; }

// connected components over links heard in the last 3 s (either direction)
std::vector<int> components() {
  std::vector<int> comp(NV, -1); int c = 0;
  for (int s = 0; s < NV; ++s) {
    if (!S.v[s].alive || comp[s] >= 0) continue;
    std::vector<int> st{s}; comp[s] = c;
    while (!st.empty()) {
      int a = st.back(); st.pop_back();
      for (int b = 0; b < NV; ++b) if (S.v[b].alive && comp[b] < 0 && (heardRecently(a, b, 3) || heardRecently(b, a, 3))) { comp[b] = c; st.push_back(b); }
    }
    ++c;
  }
  return comp;
}

// ---------------------------------------------------------------- nav: truth -> belief
void nav(int i) {
  Vehicle& a = S.v[i];
  bool jammed = inAny(S.jams, a.x, a.y);
  bool spoofed = inAny(S.spoofs, a.x, a.y);
  if (spoofed && !jammed) { a.spoof_dx += 3.5 * DT; a.spoof_dy += 1.8 * DT; }    // a pull-off, slow enough to look plausible
  else if (!spoofed) { a.spoof_dx = a.spoof_dy = 0; }

  // The independent reference the product's detector compares GNSS against. It must NOT follow
  // GNSS -- a reference that tracks the fix can never disagree with a spoofed fix. Modelled as
  // airspeed/odometry-aided inertial error: a bounded random walk with a 20 m 1-sigma.
  a.ins_ex = std::max(-15.0, std::min(15.0, a.ins_ex + S.rng.n() * 0.3));
  a.ins_ey = std::max(-15.0, std::min(15.0, a.ins_ey + S.rng.n() * 0.3));
  PositionBelief dr(Eigen::Vector3d(a.x + a.ins_ex, a.y + a.ins_ey, 0), Eigen::Matrix3d::Identity() * 400.0);
  bool gnss = !jammed && !(a.spoof_known && spoofed);
  if (gnss) {
    PositionBelief fix(Eigen::Vector3d(a.x + a.spoof_dx + S.rng.n() * 2, a.y + a.spoof_dy + S.rng.n() * 2, 0), Eigen::Matrix3d::Identity() * 9.0);
    N::SpoofVerdict before = a.spoof.verdict();
    N::SpoofVerdict vd = a.spoof.Update(fix, dr, S.t);
    if (vd == N::SpoofVerdict::kSpoofDetected && before != vd) {
      a.spoof_known = true;
      logf("%s  GNSS SPOOF DETECTED  nis %.1f  gnss dropped as a source", vname(i).c_str(), a.spoof.last_nis());
      gnss = false;
    }
  }
  if (!spoofed && a.spoof_known) { a.spoof_known = false; a.spoof.Rearm(S.t); }

  if (gnss) {
    // follows the fix -- including a spoofed one the detector has not convicted yet
    a.ex += (a.spoof_dx - a.ex) * 0.5 + S.rng.n() * 0.4; a.ey += (a.spoof_dy - a.ey) * 0.5 + S.rng.n() * 0.4;
    a.sigma = 3.0; a.src = NavSource::kGnss;
  } else {
    const double drift = a.kind == FW ? 0.9 : 0.35;
    a.ex += S.rng.n() * drift * DT * 2; a.ey += S.rng.n() * drift * DT * 2;
    a.sigma = std::min(a.sigma + drift * DT * 1.6, 900.0); a.src = NavSource::kDeadReckon;
    // peers that hear us and still have good nav lend a fix -- the product's cooperative fusion
    std::vector<N::RelativeFix> fixes;
    for (int j = 0; j < NV; ++j) {
      const Vehicle& p = S.v[j];
      if (j == i || !p.alive || p.src != NavSource::kGnss || !heardRecently(i, j, 2)) continue;
      N::RelativeFix f; f.from_node = j + 1;
      double rng_err = 8 + 0.01 * std::hypot(p.x - a.x, p.y - a.y);
      f.observed_position = Eigen::Vector3d(a.x + p.ex + S.rng.n() * rng_err, a.y + p.ey + S.rng.n() * rng_err, 0);
      f.covariance = Eigen::Matrix3d::Identity() * (rng_err * rng_err + 9);
      fixes.push_back(f);
    }
    if (!fixes.empty()) {
      PositionBelief own = beliefOf(a);
      PositionBelief fused = N::FuseCooperative(own, fixes, 5.0);
      a.ex = fused.mean().x() - a.x; a.ey = fused.mean().y() - a.y;
      a.sigma = fused.MaxSigma(); a.src = NavSource::kCooperative;
    }
  }
}

// ---------------------------------------------------------------- health + quorum (product)
void health(int i, bool operator_link) {
  Vehicle& a = S.v[i];
  if (a.src != a.logged_src) {
    const char* what = a.src == NavSource::kGnss ? "GNSS restored"
                     : a.src == NavSource::kCooperative ? "GNSS lost  ranging off peers"
                     : "GNSS lost  dead reckoning, uncertainty growing";
    if (!(a.logged_src == NavSource::kCooperative && a.src == NavSource::kDeadReckon) &&
        !(a.logged_src == NavSource::kDeadReckon && a.src == NavSource::kCooperative)) group(vname(i), what);
    a.logged_src = a.src;
  }
  int live = 0; double worst = 0;
  for (int j = 0; j < NV; ++j) {
    if (j == i) continue;
    double age = S.t - a.heard[j];
    if (age <= 3) ++live; else if (age < 45) worst = std::max(worst, age);
  }
  H::HealthInputs in;
  in.live_peers = live; in.worst_peer_age_s = worst; in.nav_source = a.src;
  in.position_sigma_m = a.sigma; in.spoof_detected = a.spoof_known;
  in.clock_quality = a.src == NavSource::kGnss ? ClockQuality::kGpsSynced : ClockQuality::kMeshSynced;
  in.battery_fraction = a.battery;
  H::Rung was = a.ladder.rung();
  a.ladder.Update(in);
  if (a.ladder.rung() != was) a.rung_since = S.t;
  a.rung = (int)a.ladder.rung();
  // The ladder steps one rung per update, so a recovery passes THROUGH intermediate rungs in
  // consecutive half-seconds. Log only a rung that has held for a second -- otherwise a vehicle
  // with perfect GPS is reported "DEGRADED_NAV" on its way back from a comms outage.
  if (a.rung != a.logged_rung && S.t - a.rung_since >= 1.0) {
    group(vname(i), std::string(H::ToString((H::Rung)a.logged_rung)) + " -> " + H::ToString(a.ladder.rung()));
    a.logged_rung = a.rung;
  }
  a.quorum.Update(live, operator_link, S.t);
  if (a.quorum.just_changed())
    group(vname(i), std::string("regime ") + H::ToString(a.quorum.previous_regime()) + " -> " +
          H::ToString(a.quorum.regime()) + "  gives up: " + a.quorum.capabilities().surrendered);
  a.regime = (int)a.quorum.regime();
}

// ---------------------------------------------------------------- allocation (product CBBA)
void allocate() {
  std::vector<int> comp = components();
  int ncomp = 0; for (int c : comp) ncomp = std::max(ncomp, c + 1);

  // leases: a claim is renewed while its owner is heard by anyone
  for (auto& k : S.tasks) {
    if (k.st != CLAIMED) continue;
    const int o = k.owner;
    double last = -1e9; for (int j = 0; j < NV; ++j) if (j != o) last = std::max(last, S.v[j].heard[o]);
    double age = S.t - last;
    if (age > 3) {
      // the product decides when silence means the work may be taken
      double lease_left = k.lease_until - S.t;
      if (H::MayReallocatePeerWork(age, lease_left)) {
        char w[96]; std::snprintf(w, sizeof w, "declared %s (silent %.0f s, lease expired)  work released", H::ToString(H::ClassifyPeer(age)), age);
        bool seen = false; for (auto& p : pending) if (p.first == w && p.second == vname(o)) seen = true;
        if (!seen) group(vname(o), w);
        // measured from SILENCE, not from release
        k.st = OPEN; k.lost_at = k.lost_at < 0 ? last : k.lost_at; k.lost_from = o; k.owner = -1;
      }
    } else k.lease_until = S.t + LEASE_S;
  }

  for (int c = 0; c < ncomp; ++c) {
    std::vector<int> mem;
    for (int i = 0; i < NV; ++i) {
      if (comp[i] != c) continue;
      const Vehicle& a = S.v[i];
      if (!a.ladder.permissions().may_accept_new_tasks) continue;
      mem.push_back(i);
    }
    if (mem.empty()) continue;
    // pool: open work, plus work already held by members of this group (they may trade it)
    std::vector<int> pool;
    for (int k = 0; k < (int)S.tasks.size(); ++k) {
      const Task_& tk = S.tasks[k];
      if (tk.st == DONE) continue;
      if (tk.st == CLAIMED && std::find(mem.begin(), mem.end(), tk.owner) == mem.end()) continue;
      pool.push_back(k);
    }
    if (pool.empty()) continue;
    std::vector<T::Task> tv;
    for (int k : pool) {
      T::Task t; t.id = (T::TaskId)(k + 1);
      t.location = PositionBelief(Eigen::Vector3d(S.tasks[k].x, S.tasks[k].y, 0), Eigen::Matrix3d::Identity() * 25.0);
      t.base_value = 10.0; t.service_time_s = 20.0;
      t.req.domain_mask = S.tasks[k].water ? (T::kDomainAir | T::kDomainSurface) : (T::kDomainAir | T::kDomainGround);
      t.req.max_agent_position_sigma_m = 60.0;     // C13: a node that does not know where it is may not claim a station
      tv.push_back(t);
    }
    std::vector<T::CbbaAgent> ag;
    ag.reserve(mem.size());
    for (size_t m = 0; m < mem.size(); ++m) {
      T::AgentState st; st.id = (T::AgentId)(m + 1); st.profile = profileOf(S.v[mem[m]].kind);
      st.position = beliefOf(S.v[mem[m]]); st.energy_fraction = S.v[mem[m]].battery;
      ag.emplace_back(st, &tv, mem.size(), &S.score);
    }
    int rounds = 0; bool done = false;
    while (!done && rounds < 80) {
      for (auto& a : ag) a.BuildBundle();
      std::vector<T::ConsensusMessage> msgs; for (auto& a : ag) msgs.push_back(a.Publish());
      for (size_t r = 0; r < ag.size(); ++r)
        for (size_t s = 0; s < ag.size(); ++s) {
          if (r == s) continue;
          if (!(heardRecently(mem[r], mem[s], 3))) continue;        // consensus only over real links
          if (S.rng.u() >= S.bandwidth) continue;
          ag[r].Receive(msgs[s], S.t);
        }
      done = true;
      for (auto& a : ag) if (a.Tick() == T::ConvergenceOutcome::kInProgress) done = false;
      ++rounds;
    }
    S.rounds_last = rounds; S.outcome_last = (int)ag[0].outcome();
    for (size_t m = 0; m < mem.size(); ++m) {
      Vehicle& a = S.v[mem[m]];
      std::vector<int> np;
      for (T::TaskId id : ag[m].PathTaskIds()) np.push_back((int)id - 1);
      for (int k : np) {
        Task_& tk = S.tasks[k];
        if (tk.owner != mem[m]) {
          if (tk.lost_at >= 0) {
            S.last_realloc_s = S.t - tk.lost_at;
            { char w[96]; std::snprintf(w, sizeof w, "took station %d from %s  %.0f s after it went silent", k + 1, vname(tk.lost_from).c_str(), S.last_realloc_s); group(vname(mem[m]), w); }
            tk.lost_at = -1;
          }
          tk.owner = mem[m]; tk.st = CLAIMED; tk.lease_until = S.t + LEASE_S;
        }
      }
      // work this node held but no longer won goes back to the pool
      for (int k : a.path) if (std::find(np.begin(), np.end(), k) == np.end() && S.tasks[k].owner == mem[m] && S.tasks[k].st == CLAIMED) { S.tasks[k].st = OPEN; S.tasks[k].owner = -1; }
      if (a.path.empty() != np.empty() || (!np.empty() && a.path[0] != np[0])) a.service_left = -1;
      a.path = np;
    }
  }
}

// ---------------------------------------------------------------- motion
void move(int i) {
  Vehicle& a = S.v[i];
  double spd = a.kind == FW ? 18 : (a.kind == UGV ? 5 : 4.5);
  double bx = a.x + a.ex, by = a.y + a.ey, tx, ty;
  if (!a.path.empty()) { tx = S.tasks[a.path[0]].x; ty = S.tasks[a.path[0]].y; }
  else { tx = a.kind == USV ? 700 : 520; ty = a.kind == USV ? 1650 : 520; }
  double dx = tx - bx, dy = ty - by, d = std::hypot(dx, dy);
  if (!a.path.empty() && d < 40) {
    if (a.service_left < 0) a.service_left = 20;
    a.service_left -= DT;
    if (a.kind == FW) { a.orbit += DT * 0.22; tx += std::cos(a.orbit) * 80; ty += std::sin(a.orbit) * 80; dx = tx - bx; dy = ty - by; d = std::hypot(dx, dy); }
    else spd = 0.4;
    if (a.service_left <= 0) {
      Task_& tk = S.tasks[a.path[0]];
      if (std::hypot(tk.x - a.x, tk.y - a.y) < 130) {
        tk.st = DONE; tk.owner = i;
        logf("%s  station %d surveyed", vname(i).c_str(), a.path[0] + 1);
      } else {
        logf("%s  station %d NOT surveyed: navigation error %.0f m put it in the wrong place", vname(i).c_str(), a.path[0] + 1, std::hypot(a.ex, a.ey));
        tk.st = OPEN; tk.owner = -1;
      }
      a.path.erase(a.path.begin()); a.service_left = -1;
    }
  } else if (a.kind == FW && d < 1) { a.hd += 0.2; }
  if (a.kind == FW && d < 40 && a.path.empty()) { a.orbit += DT * 0.2; dx = std::cos(a.orbit); dy = std::sin(a.orbit); d = 1; }
  double want = std::atan2(dy, dx);
  double turn = std::remainder(want - a.hd, 6.283185307179586);
  double maxr = (a.kind == FW ? 0.35 : 1.0) * DT;
  a.hd += std::max(-maxr, std::min(maxr, turn));
  a.x += std::cos(a.hd) * spd * DT; a.y += std::sin(a.hd) * spd * DT;
  if (a.kind == UGV) a.y = std::min(a.y, SHORE - 30);
  if (a.kind == USV) a.y = std::max(a.y, SHORE + 30);
  a.x = std::max(20.0, std::min(W - 20, a.x)); a.y = std::max(20.0, std::min(Hm - 20, a.y));
  a.battery = std::max(0.0, a.battery - DT / (a.kind == FW ? 9000.0 : 30000.0));
}

void step() {
  radio();
  // an operator link exists if the ground station (south-west corner) is reachable through the mesh
  std::vector<int> comp = components();
  int gcsComp = -1; double best = 1e18;
  for (int i = 0; i < NV; ++i) if (S.v[i].alive) { double d = std::hypot(S.v[i].x - 150, S.v[i].y - 150); if (d < 1600 && d < best) { best = d; gcsComp = comp[i]; } }
  for (int i = 0; i < NV; ++i) if (S.v[i].alive) { nav(i); health(i, comp[i] == gcsComp); }
  if (S.t >= S.next_alloc) { allocate(); S.next_alloc = S.t + 2.0; }
  for (int i = 0; i < NV; ++i) if (S.v[i].alive) move(i);
  flushGroups();
  S.t += DT;
  if (!S.complete) {
    bool all = true; for (auto& k : S.tasks) if (k.st != DONE) { all = false; break; }
    if (all) { S.complete = true; S.complete_at = S.t; logf("MISSION COMPLETE  every station surveyed"); }
  }
}

uint64_t fnv(uint64_t h, const void* p, size_t n) { const uint8_t* b = (const uint8_t*)p; for (size_t i = 0; i < n; ++i) { h ^= b[i]; h *= 1099511628211ull; } return h; }

double out_buf[4096];

}  // namespace

// ================================================================ C ABI for the worker
extern "C" {
__attribute__((export_name("sim_init")))      void sim_init(double seed) { reset((uint64_t)seed); }
__attribute__((export_name("sim_step")))      void sim_step(int n) { for (int i = 0; i < n; ++i) step(); }
__attribute__((export_name("sim_jam")))       void sim_jam(double x0, double y0, double x1, double y1) {
  S.jams.push_back({std::min(x0, x1), std::min(y0, y1), std::max(x0, x1), std::max(y0, y1)});
  logf("ADVERSARY  GNSS jamming over %.0f x %.0f m", std::fabs(x1 - x0), std::fabs(y1 - y0)); }
__attribute__((export_name("sim_spoof")))     void sim_spoof(double x0, double y0, double x1, double y1) {
  S.spoofs.push_back({std::min(x0, x1), std::min(y0, y1), std::max(x0, x1), std::max(y0, y1)});
  logf("ADVERSARY  GNSS spoofing over %.0f x %.0f m", std::fabs(x1 - x0), std::fabs(y1 - y0)); }
__attribute__((export_name("sim_sever")))     void sim_sever(int a, int b) {
  if (a < 0 || b < 0 || a >= NV || b >= NV || a == b || severed(a, b)) return;
  S.severed.push_back({a, b}); logf("ADVERSARY  link %s <-> %s severed", vname(a).c_str(), vname(b).c_str()); }
__attribute__((export_name("sim_destroy")))   void sim_destroy(int i) {
  if (i < 0 || i >= NV || !S.v[i].alive) return;
  S.v[i].alive = false; logf("ADVERSARY  %s destroyed", vname(i).c_str()); }
__attribute__((export_name("sim_bandwidth"))) void sim_bandwidth(double f) {
  S.bandwidth = std::max(0.02, std::min(1.0, f)); logf("ADVERSARY  bandwidth cut to %.0f%%", S.bandwidth * 100); }
__attribute__((export_name("sim_time")))      double sim_time() { return S.t; }
__attribute__((export_name("sim_nv")))        int sim_nv() { return NV; }
__attribute__((export_name("sim_ntasks")))    int sim_ntasks() { return (int)S.tasks.size(); }

// vehicles: 14 doubles each; tasks: 4 each; then links as NV*NV; returns pointer
__attribute__((export_name("sim_snapshot")))  double* sim_snapshot() {
  int o = 0;
  for (int i = 0; i < NV; ++i) {
    const Vehicle& a = S.v[i];
    double tx = -1, ty = -1; if (!a.path.empty()) { tx = S.tasks[a.path[0]].x; ty = S.tasks[a.path[0]].y; }
    double v[14] = {a.x, a.y, a.x + a.ex, a.y + a.ey, a.sigma, a.hd, (double)a.alive, (double)a.rung, (double)a.regime,
                    (double)a.kind, tx, ty, (double)a.src, a.spoof_known ? 1.0 : 0.0};
    std::memcpy(out_buf + o, v, sizeof v); o += 14;
  }
  for (auto& k : S.tasks) { out_buf[o++] = k.x; out_buf[o++] = k.y; out_buf[o++] = k.st; out_buf[o++] = k.owner; }
  for (int i = 0; i < NV * NV; ++i) out_buf[o++] = S.link[i];
  return out_buf;
}
// metrics: alive, completion %, owned %, connectivity %, last reallocate s, t, complete_at, rounds, outcome
__attribute__((export_name("sim_metrics")))   double* sim_metrics() {
  static double m[10];
  int alive = 0, done = 0, owned = 0, open = 0;
  for (auto& a : S.v) alive += a.alive;
  for (auto& k : S.tasks) { done += k.st == DONE; owned += k.st == CLAIMED; open += k.st != DONE; }
  std::vector<int> comp = components(); std::vector<int> cnt(NV, 0); int big = 0;
  for (int i = 0; i < NV; ++i) if (S.v[i].alive) big = std::max(big, ++cnt[comp[i]]);
  m[0] = alive; m[1] = 100.0 * done / S.tasks.size(); m[2] = open ? 100.0 * owned / open : 100.0;
  m[3] = alive ? 100.0 * big / alive : 0; m[4] = S.last_realloc_s; m[5] = S.t; m[6] = S.complete_at;
  m[7] = S.rounds_last; m[8] = S.outcome_last; m[9] = S.bandwidth;
  return m;
}
__attribute__((export_name("sim_log_ptr")))   const char* sim_log_ptr() { return S.log.c_str(); }
__attribute__((export_name("sim_log_len")))   int sim_log_len() { return (int)S.log.size(); }
__attribute__((export_name("sim_log_clear"))) void sim_log_clear() { S.log.clear(); }
// determinism: hash of everything that evolves, quantised so the hash is about behaviour
__attribute__((export_name("sim_hash")))      double sim_hash() {
  uint64_t h = 1469598103934665603ull;
  for (auto& a : S.v) { int64_t q[6] = {(int64_t)std::llround(a.x * 100), (int64_t)std::llround(a.y * 100), (int64_t)std::llround(a.sigma * 100), a.alive, a.rung, a.regime}; h = fnv(h, q, sizeof q); }
  for (auto& k : S.tasks) { int32_t q[2] = {(int32_t)k.st, k.owner}; h = fnv(h, q, sizeof q); }
  return (double)(h >> 11);   // 53 bits survive the trip through a JS number
}
}
