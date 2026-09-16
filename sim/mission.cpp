// Homingvector site: UAV SWARM MISSION engine around the TurtleShield decision core.
//
// WHAT IS PRODUCT CODE AND WHAT IS NOT -- stated first because the page makes claims from it.
//   PRODUCT (compiled unchanged from the TurtleShield repo at the sha in provenance.json):
//     task::CbbaAgent + TimeDiscountedScore    which aircraft flies which search lane, and re-tasking
//     task::PlanRing                           assembly / rendezvous / hold loiter-ring slots
//     task::CheckSeparation                    separation monitor and climb-to-layer yields
//     health::DegradationLadder, PermissionsFor per-aircraft degraded modes; formation spacing is
//                                              widened by the ladder's own geofence_margin_scale
//     health::QuorumPolicy                     what a group of this size may still do
//     health::ClassifyPeer, MayReallocatePeerWork, PolicyForIsolation
//                                              when a silent aircraft's work may be taken, and what a
//                                              cut-off aircraft does on its own
//     nav::FuseCooperative                     peer-aided navigation while GPS is unavailable
//   DEMONSTRATION CODE (this file, site-owned, NOT product): the mission phase script, the wedge / V /
//     line / column slot geometry, the leader-follower steering law, the radio and navigation error
//     models, and the scenario event timelines. TurtleShield itself ships no wedge/V/line/column
//     formation logic -- this page must never say it does.
//
// Deterministic: one xorshift64* stream, fixed step, no clock, no <random> distributions.
#include <algorithm>
#include <cmath>
#include <cstdarg>
#include <cstdint>
#include <cstdio>
#include <cstring>
#include <new>
#include <string>
#include <vector>

#include "core/common/geodesy.h"
#include "core/health/degradation.h"
#include "core/health/failure_response.h"
#include "core/health/quorum_policy.h"
#include "core/nav/spoof_detector.h"
#include "core/task/cbba.h"
#include "core/task/formation.h"
#include "core/task/score.h"
#include "core/task/separation.h"
#include "core/task/task.h"
#include "tests/task_fixtures.h"

using namespace turtleshield;
namespace T = turtleshield::task;
namespace H = turtleshield::health;
namespace N = turtleshield::nav;

namespace {

struct Rng {
  uint64_t s = 0x9E3779B97F4A7C15ull;
  void seed(uint64_t v) { s = v ? v * 0x2545F4914F6CDD1Dull + 1 : 0x9E3779B97F4A7C15ull; for (int i = 0; i < 8; ++i) next(); }
  uint64_t next() { s ^= s >> 12; s ^= s << 25; s ^= s >> 27; return s * 0x2545F4914F6CDD1Dull; }
  double u() { return (next() >> 11) * (1.0 / 9007199254740992.0); }
  double n() { double a = u() + 1e-12, b = u(); return std::sqrt(-2 * std::log(a)) * std::cos(6.283185307179586 * b); }
};

constexpr double DT = 0.1;
constexpr int MAXV = 20;
constexpr double PI = 3.141592653589793;
constexpr double CRUISE = 22.0;
constexpr double SPACING = 240.0;           // > product h_min 200 m in every slot pattern below
constexpr double LEASE_S = 20.0;

enum Phase { P_LAUNCH, P_ASSEMBLY, P_FORMATION, P_TRANSIT, P_SPLIT, P_SEARCH, P_RENDEZVOUS, P_REFORM, P_RTB, P_COMPLETE };
const char* PHASE[] = {"LAUNCH", "ASSEMBLY", "FORMATION", "TRANSIT", "SPLIT", "SEARCH", "RENDEZVOUS", "REFORM", "RETURN", "COMPLETE"};
enum Form { F_WEDGE, F_V, F_LINE, F_COLUMN, F_SEARCH, F_RING };
const char* FORM[] = {"WEDGE", "V", "LINE", "COLUMN", "DISTRIBUTED SEARCH", "LOITER RING"};
enum UState { U_READY, U_ACTIVE, U_LEFT, U_REJOIN, U_COMMLOST, U_LOST, U_LANDED };
const char* USTATE[] = {"READY", "ACTIVE", "LEFT FORMATION", "REJOINING", "COMMS LOST", "LOST", "LANDED"};

struct V2 { double x, y; };
// world, metres east/north
constexpr V2 BASE{2000, 2000}, ASSEMBLE{5200, 3600}, W1{9500, 5200}, W2{13500, 5400}, W3{17000, 7000},
             RDV{16000, 11200}, W4{9000, 9000};
constexpr double AREA_X0 = 19000, AREA_X1 = 25200, AREA_Y0 = 3000, AREA_Y1 = 11000, AREA_YM = 7000;
constexpr double GPS_X0 = 8000, GPS_X1 = 15000, GPS_Y0 = 2500, GPS_Y1 = 9000;

struct Uav {
  int id = 0; int grp = 0; UState st = U_READY; bool alive = true;
  double x = 0, y = 0, alt = 0, hd = 0, spd = 0, vx = 0, vy = 0;
  double ex = 0, ey = 0, sigma = 3; NavSource src = NavSource::kGnss;
  double tx = 0, ty = 0, sx = -1, sy = -1;           // homing target, formation slot point
  double radio_fault_until = -1, left_until = -1, lost_link_at = -1;
  double heard[MAXV]; H::DegradationLadder ladder; H::QuorumPolicy quorum;
  int rung = 0, regime = 3, logged_rung = 0; double rung_since = 0;
  int layer = 0; double target_alt = 150; int lane = -1; int lane_leg = 0;
  bool isolated_logged = false; int slot = -1;
};

struct Lane { double x0, y0, x1, y1; int grp; int st = 0; int owner = -1; double lease_until = 0; double lost_at = -1; int lost_from = -1; };
struct Group { bool active = false; int leader = -1; Form form = F_WEDGE; std::vector<V2> path; int wp = 0; bool hold = false; V2 hold_at{0, 0}; };
struct Ev { int phase; double after; int kind; int arg; bool done = false; };

struct Mission {
  Rng rng; int scenario = 7; int n = 20; bool do_split = true, do_search = true;
  double t = 0, phase_t0 = 0; Phase phase = P_LAUNCH;
  Uav u[MAXV]; Group g[2]; std::vector<Lane> lanes; std::vector<Ev> script;
  bool gps_zone = false, gps_global = false, radio_degraded = false;
  int pending = 0; std::string decision; double complete_at = -1; double last_launch = -1e9;
  double next_alloc = 0, next_sep = 0; std::string log; bool split_done = false;
  uint8_t link[MAXV * MAXV]; double last_realloc_s = -1;
  CapabilityProfile plane; T::TimeDiscountedScore score; LocalFrame frame;
  std::vector<std::pair<std::string, std::string>> pending_log;
} M;

// ------------------------------------------------------------------ log (grouped per step)
void logf(const char* fmt, ...) __attribute__((format(printf, 1, 2)));
void logf(const char* fmt, ...) {
  char b[300]; va_list ap; va_start(ap, fmt); std::vsnprintf(b, sizeof b, fmt, ap); va_end(ap);
  char tb[24]; int s = (int)M.t; std::snprintf(tb, sizeof tb, "T+%02d:%02d ", s / 60, s % 60);
  M.log += tb; M.log += b; M.log += '\n';
  if (M.log.size() > 20000) M.log.erase(0, M.log.size() - 15000);
}
std::string nm(int i) { char b[8]; std::snprintf(b, sizeof b, "U%02d", i + 1); return b; }
void group_log(const std::string& who, const std::string& what) {
  for (auto& p : M.pending_log) if (p.first == what) { p.second += " " + who; return; }
  M.pending_log.push_back({what, who});
}
void flush_log() {
  for (auto& p : M.pending_log) {
    int c = 1; for (char ch : p.second) c += ch == ' ';
    if (c > 4) logf("%d UAVs  %s", c, p.first.c_str()); else logf("%s  %s", p.second.c_str(), p.first.c_str());
  }
  M.pending_log.clear();
}

double dist(double ax, double ay, double bx, double by) { return std::hypot(ax - bx, ay - by); }
double wrap(double a) { return std::remainder(a, 2 * PI); }
bool flying(const Uav& a) { return a.alive && (a.st == U_ACTIVE || a.st == U_LEFT || a.st == U_REJOIN || a.st == U_COMMLOST); }
bool in_gps_zone(double x, double y) { return M.gps_global || (M.gps_zone && x > GPS_X0 && x < GPS_X1 && y > GPS_Y0 && y < GPS_Y1); }
GeoPoint geo(double x, double y, double z) { return M.frame.FromEnu(Eigen::Vector3d(x, y, z), AltitudeFrame::kRelativeHomeM); }

void set_phase(Phase p) {
  if (p == M.phase) return;
  logf("PHASE  %s -> %s", PHASE[M.phase], PHASE[p]);
  M.phase = p; M.phase_t0 = M.t;
}

void set_form(int gi, Form f, const char* why) {
  if (M.g[gi].form == f) return;
  logf("GROUP %c  formation %s -> %s  %s", 'A' + gi, FORM[M.g[gi].form], FORM[f], why);
  M.g[gi].form = f;
}

// ------------------------------------------------------------------ scenarios
void script(int phase, double after, int kind, int arg) { Ev e; e.phase = phase; e.after = after; e.kind = kind; e.arg = arg; M.script.push_back(e); }
enum { E_GPS_ON = 1, E_GPS_OFF, E_RADIO_ON, E_RADIO_OFF, E_CUT, E_LOSE, E_LEAVE, E_FORM, E_GPSZONE };

void reset(int scenario, uint64_t seed) {
  M.~Mission(); new (&M) Mission();
  M.rng.seed(seed); M.scenario = scenario;
  M.plane = turtleshield_test::FixtureFixedWing("fw");
  GeoPoint o; o.lat_deg = 20.0; o.lon_deg = 10.0; M.frame = LocalFrame(o);
  switch (scenario) {
    case 1: M.n = 1; M.do_split = false; M.do_search = true;
            script(P_TRANSIT, 40, E_GPS_ON, 0); script(P_SEARCH, 30, E_GPS_OFF, 0); break;
    case 2: M.n = 8; M.do_split = false; M.do_search = false;
            script(P_TRANSIT, 55, E_LEAVE, 4); break;
    case 3: M.n = 20; break;
    case 4: M.n = 20; script(P_LAUNCH, 0, E_GPSZONE, 0); break;
    case 5: M.n = 20; script(P_TRANSIT, 30, E_RADIO_ON, 0); script(P_TRANSIT, 60, E_CUT, 6); script(P_SEARCH, 40, E_RADIO_OFF, 0); break;
    case 6: M.n = 20; script(P_TRANSIT, 70, E_LOSE, 0); script(P_SEARCH, 60, E_LOSE, 3); script(P_SEARCH, 110, E_LOSE, 13); break;
    default: M.n = 20;
            script(P_LAUNCH, 0, E_GPSZONE, 0); script(P_TRANSIT, 25, E_RADIO_ON, 0); script(P_TRANSIT, 45, E_CUT, 6);
            script(P_TRANSIT, 90, E_LEAVE, 4); script(P_SEARCH, 20, E_RADIO_OFF, 0); script(P_SEARCH, 70, E_LOSE, 3);
            script(P_REFORM, 5, E_FORM, 0); break;
  }
  for (int i = 0; i < M.n; ++i) {
    Uav& a = M.u[i]; a.id = i;
    a.x = BASE.x - 300 + (i % 5) * 150; a.y = BASE.y - 400 + (i / 5) * 150; a.alt = 0; a.hd = 0.6;
    for (int j = 0; j < MAXV; ++j) a.heard[j] = -1e9;
  }
  M.g[0].active = true; M.g[0].form = F_RING;
  M.g[0].path = {W1, W2, W3};
  std::memset(M.link, 0, sizeof M.link);
  logf("MISSION  scenario %d  %d UAVs  seed %llu", scenario, M.n, (unsigned long long)seed);
}

// ------------------------------------------------------------------ radio (mesh relay)
void radio() {
  std::memset(M.link, 0, sizeof M.link);
  const double range = M.radio_degraded ? 3200 : 6000, drop = M.radio_degraded ? .35 : .02;
  for (int i = 0; i < M.n; ++i) for (int j = i + 1; j < M.n; ++j) {
    Uav& a = M.u[i]; Uav& b = M.u[j];
    if (!flying(a) || !flying(b)) continue;
    if (M.t < a.radio_fault_until || M.t < b.radio_fault_until) continue;
    if (dist(a.x, a.y, b.x, b.y) > range) continue;
    if (M.rng.u() < drop) continue;
    M.link[i * MAXV + j] = M.link[j * MAXV + i] = 1;
  }
  int comp[MAXV]; for (int i = 0; i < MAXV; ++i) comp[i] = -1; int c = 0;
  for (int s = 0; s < M.n; ++s) {
    if (!flying(M.u[s]) || comp[s] >= 0) continue;
    std::vector<int> st{s}; comp[s] = c;
    while (!st.empty()) { int a = st.back(); st.pop_back(); for (int b = 0; b < M.n; ++b) if (comp[b] < 0 && M.link[a * MAXV + b]) { comp[b] = c; st.push_back(b); } }
    ++c;
  }
  for (int i = 0; i < M.n; ++i) for (int j = 0; j < M.n; ++j) if (i != j && comp[i] >= 0 && comp[i] == comp[j]) M.u[j].heard[i] = M.t;
}
bool hears(int j, int i) { return M.t - M.u[j].heard[i] <= 3.0; }

// ------------------------------------------------------------------ navigation (product cooperative fusion)
void nav(Uav& a) {
  if (!in_gps_zone(a.x, a.y)) {
    if (a.src != NavSource::kGnss) group_log(nm(a.id), "GPS restored");
    a.ex *= .9; a.ey *= .9; a.sigma = 3; a.src = NavSource::kGnss; return;
  }
  if (a.src == NavSource::kGnss) group_log(nm(a.id), "GPS unavailable  navigating on inertial + peers");
  a.ex += M.rng.n() * .25; a.ey += M.rng.n() * .25;
  a.sigma = std::min(a.sigma + .9 * DT, 800.0); a.src = NavSource::kDeadReckon;
  std::vector<N::RelativeFix> fixes;
  for (int j = 0; j < M.n; ++j) {
    Uav& p = M.u[j];
    if (j == a.id || !flying(p) || p.src != NavSource::kGnss || !hears(a.id, j)) continue;
    double r = dist(a.x, a.y, p.x, p.y); if (r > 4000) continue;
    N::RelativeFix f; f.from_node = j + 1; double e = 10 + .01 * r;
    f.observed_position = Eigen::Vector3d(a.x + p.ex + M.rng.n() * e, a.y + p.ey + M.rng.n() * e, 0);
    f.covariance = Eigen::Matrix3d::Identity() * (e * e + 9); fixes.push_back(f);
  }
  if (!fixes.empty()) {
    PositionBelief own(Eigen::Vector3d(a.x + a.ex, a.y + a.ey, 0), Eigen::Matrix3d::Identity() * (a.sigma * a.sigma));
    own.stamp.quality = ClockQuality::kMeshSynced;
    PositionBelief fz = N::FuseCooperative(own, fixes, 5.0);
    a.ex = fz.mean().x() - a.x; a.ey = fz.mean().y() - a.y; a.sigma = fz.MaxSigma(); a.src = NavSource::kCooperative;
  }
}

// ------------------------------------------------------------------ health (product ladder + quorum + isolation policy)
void health(Uav& a) {
  int live = 0; double worst = 0;
  for (int j = 0; j < M.n; ++j) { if (j == a.id) continue; double age = M.t - a.heard[j]; if (age <= 3) ++live; else if (age < 45) worst = std::max(worst, age); }
  H::HealthInputs in; in.live_peers = live; in.worst_peer_age_s = worst; in.nav_source = a.src; in.position_sigma_m = a.sigma;
  in.clock_quality = a.src == NavSource::kGnss ? ClockQuality::kGpsSynced : ClockQuality::kMeshSynced;
  H::Rung was = a.ladder.rung(); a.ladder.Update(in);
  if (a.ladder.rung() != was) a.rung_since = M.t;
  a.rung = (int)a.ladder.rung();
  if (a.rung != a.logged_rung && M.t - a.rung_since >= 1.0) {
    group_log(nm(a.id), std::string(H::ToString((H::Rung)a.logged_rung)) + " -> " + H::ToString(a.ladder.rung())); a.logged_rung = a.rung;
  }
  a.quorum.Update(live, true, M.t); a.regime = (int)a.quorum.regime();
  // comms: a flying aircraft that hears nobody is cut off; the product decides what it may do
  // cut off = nobody heard while others ARE airborne; the first aircraft off the ground is alone, not cut off
  int others = 0; for (int j = 0; j < M.n; ++j) if (j != a.id && flying(M.u[j])) ++others;
  bool cut = live == 0 && others > 0 && M.t - M.last_launch > 6.0;
  if (cut && a.st != U_COMMLOST && (a.st == U_ACTIVE || a.st == U_LEFT || a.st == U_REJOIN)) {
    a.st = U_COMMLOST; a.lost_link_at = M.t;
    H::ContingencyPlan agreed; agreed.action = H::ContingencyPlan::Action::kContinueThenRtl;
    H::IsolationPolicy pol = H::PolicyForIsolation(M.t, 30.0, agreed);
    logf("%s  COMMS LOST  isolation policy: new tasks %s, continue current %s, then return", nm(a.id).c_str(),
         pol.may_accept_new_tasks ? "allowed" : "refused", pol.may_continue_current ? "yes" : "no");
  } else if (!cut && a.st == U_COMMLOST) {
    a.st = U_REJOIN; logf("%s  link restored after %.0f s  REJOINING", nm(a.id).c_str(), M.t - a.lost_link_at);
  }
}

// ------------------------------------------------------------------ groups, leaders, slots
std::vector<int> members(int gi) { std::vector<int> v; for (int i = 0; i < M.n; ++i) if (M.u[i].grp == gi && flying(M.u[i])) v.push_back(i); return v; }
void elect(int gi) {
  int old = M.g[gi].leader, best = -1;
  for (int i : members(gi)) if (M.u[i].st == U_ACTIVE || M.u[i].st == U_REJOIN) { best = i; break; }
  if (best != old) { if (old >= 0 && best >= 0) logf("GROUP %c  leader %s -> %s", 'A' + gi, nm(old).c_str(), nm(best).c_str()); M.g[gi].leader = best; }
}
double spacing_scale(int gi) {   // the PRODUCT's degraded-mode margin, applied to the formation
  double s = 1.0; for (int i : members(gi)) s = std::max(s, H::PermissionsFor(M.u[i].ladder.rung()).geofence_margin_scale); return s;
}
V2 slot_offset(Form f, int k, double S) {   // k = 1.. follower rank; x back (+), y right (+)
  int r = (k + 1) / 2; double side = (k % 2) ? -1 : 1;
  switch (f) {
    case F_WEDGE: { int row = 1, used = 0; while (used + row + 1 < k) { used += row + 1; ++row; } int j = k - used - 1; return {row * S * .95, (j - row / 2.0) * S}; }
    case F_V:      return {r * S * .8, side * r * S};
    case F_LINE:   return {0, side * r * S};
    case F_COLUMN: return {k * S * .95, 0};
    default:       return {0, 0};
  }
}

void steer(Uav& a, double px, double py, double want_spd) {
  // steer from the BELIEVED position: navigation error becomes real flight error
  double bx = a.x + a.ex, by = a.y + a.ey;
  double want = std::atan2(py - by, px - bx), turn = wrap(want - a.hd), maxr = .32 * DT;
  a.hd = wrap(a.hd + std::max(-maxr, std::min(maxr, turn)));
  want_spd = std::max(14.0, std::min(32.0, want_spd));
  a.spd += std::max(-2.0 * DT, std::min(2.0 * DT, want_spd - a.spd));
  a.vx = std::cos(a.hd) * a.spd; a.vy = std::sin(a.hd) * a.spd;
  a.x += a.vx * DT; a.y += a.vy * DT;
  a.alt += std::max(-3.0 * DT, std::min(3.0 * DT, a.target_alt - a.alt));
  a.tx = px; a.ty = py;
}
void orbit(Uav& a, V2 c, double r) {
  double ang = std::atan2(a.y - c.y, a.x - c.x) + 700.0 / r * .6;
  steer(a, c.x + std::cos(ang) * r, c.y + std::sin(ang) * r, CRUISE);
}

// ring slots from the PRODUCT's PlanRing, rotating with time so the ring flies
void ring_targets(const std::vector<int>& ids, V2 c, double& radius_out) {
  std::vector<T::AssignAgent> ag;
  for (int i : ids) { T::AssignAgent x; x.id = (T::AgentId)(i + 1); x.position = geo(M.u[i].x, M.u[i].y, 0); ag.push_back(x); }
  T::RingConfig cfg; cfg.min_chord_m = 260; cfg.radius_m = std::max(700.0, T::MinRadiusForAgents((int)ids.size(), 260) + 60);
  // the ring turns SLOWER than cruise, so an aircraft behind its slot can always catch it
  cfg.align_to_fleet = false; cfg.phase_offset_rad = std::fmod(M.t * .55 * CRUISE / cfg.radius_m, 2 * PI);
  T::RingPlan plan = T::PlanRing(ag, geo(c.x, c.y, 0), cfg);
  radius_out = cfg.radius_m;
  if (!plan.ok) { for (int i : ids) orbit(M.u[i], c, cfg.radius_m); return; }
  for (int i : ids) {
    const T::RingSlot* s = plan.For((T::AgentId)(i + 1));
    if (!s) { orbit(M.u[i], c, cfg.radius_m); continue; }
    Eigen::Vector3d e = M.frame.ToEnu(s->point);
    // lead the slot along the ring so a fixed-wing can hold it
    double ang = std::atan2(e.y() - c.y, e.x() - c.x) + .35;
    Uav& a = M.u[i]; a.sx = e.x(); a.sy = e.y();
    double d = dist(a.x, a.y, e.x(), e.y());
    if (d > 350) steer(a, e.x(), e.y(), CRUISE + std::min(9.0, d * .01));          // far: cut across to the slot
    else steer(a, c.x + std::cos(ang) * cfg.radius_m, c.y + std::sin(ang) * cfg.radius_m, .55 * CRUISE + d * .03);
  }
}

bool fly_formation(int gi) {   // returns true when the leader reached its path end
  Group& G = M.g[gi]; elect(gi);
  if (G.leader < 0) return false;
  auto mem = members(gi); double S = SPACING * spacing_scale(gi);
  Uav& L = M.u[G.leader];
  if (G.hold) { double r; ring_targets(mem, G.hold_at, r); for (int i : mem) M.u[i].slot = -1; return false; }
  bool arrived = false;
  if (G.wp < (int)G.path.size()) {
    V2 w = G.path[G.wp];
    // leader slows while followers are still out of their slots
    double lag = 0; int cnt = 0;
    for (int i : mem) if (i != G.leader && M.u[i].sx >= 0) { lag += dist(M.u[i].x, M.u[i].y, M.u[i].sx, M.u[i].sy); ++cnt; }
    double spd = CRUISE - std::min(6.0, cnt ? lag / cnt * .01 : 0);
    steer(L, w.x, w.y, spd); L.sx = -1;
    if (dist(L.x, L.y, w.x, w.y) < 450) { G.wp++; if (G.wp >= (int)G.path.size()) arrived = true; }
  } else arrived = true;
  if (arrived) orbit(L, G.path.empty() ? V2{L.x, L.y} : G.path.back(), 700);
  int k = 0; double fx = std::cos(L.hd), fy = std::sin(L.hd);
  for (int i : mem) {
    if (i == G.leader) continue;
    Uav& a = M.u[i]; ++k; a.slot = k;
    if (a.st == U_COMMLOST) {   // cut off: product isolation policy -- continue, then return
      if (M.t - a.lost_link_at < 45) steer(a, a.x + std::cos(a.hd) * 1000, a.y + std::sin(a.hd) * 1000, CRUISE);
      else steer(a, BASE.x, BASE.y, CRUISE);
      a.sx = -1; continue;
    }
    if (a.st == U_LEFT) {
      if (M.t < a.left_until) { double ang = M.t * .05 + i; steer(a, a.x + std::cos(a.hd + .6) * 800 + std::cos(ang) * 10, a.y + std::sin(a.hd + .6) * 800, CRUISE - 2); a.sx = -1; continue; }
      a.st = U_REJOIN; logf("%s  sensor check complete  REJOINING slot %d", nm(i).c_str(), k);
    }
    if (!hears(i, G.leader)) { steer(a, a.x + std::cos(a.hd) * 1000, a.y + std::sin(a.hd) * 1000, CRUISE); a.sx = -1; continue; }
    V2 o = slot_offset(G.form, k, S);
    double px = L.x + L.ex - fx * o.x - fy * o.y, py = L.y + L.ey - fy * o.x + fx * o.y;   // leader's broadcast position
    a.sx = px; a.sy = py;
    double bx = a.x + a.ex, by = a.y + a.ey, along = (px - bx) * fx + (py - by) * fy;
    double aim_x = px + fx * 350, aim_y = py + fy * 350;
    steer(a, aim_x, aim_y, L.spd + std::max(-6.0, std::min(9.0, along * .03)));
    if (a.st == U_REJOIN && dist(a.x, a.y, px, py) < 160) { a.st = U_ACTIVE; logf("%s  back in slot %d  %s formation", nm(i).c_str(), k, FORM[G.form]); }
  }
  return arrived;
}

// ------------------------------------------------------------------ search lanes (product CBBA)
void build_lanes() {
  M.lanes.clear();
  int per = M.do_split ? std::max(1, M.n / 2) : std::max(3, M.n);
  for (int gi = 0; gi < (M.do_split ? 2 : 1); ++gi) {
    double y0 = M.do_split ? (gi == 0 ? AREA_YM + 250 : AREA_Y0 + 250) : AREA_Y0 + 250;
    double y1 = M.do_split ? (gi == 0 ? AREA_Y1 - 250 : AREA_YM - 250) : AREA_Y1 - 250;
    if (!M.do_split && M.n == 1) { y0 = AREA_YM + 400; y1 = AREA_Y1 - 400; }
    int nl = M.n == 1 ? 3 : per;
    for (int k = 0; k < nl; ++k) {
      double x = AREA_X0 + 300 + (AREA_X1 - AREA_X0 - 600) * (nl == 1 ? .5 : (double)k / (nl - 1));
      Lane l; l.x0 = x; l.y0 = (k % 2) ? y1 : y0; l.x1 = x; l.y1 = (k % 2) ? y0 : y1; l.grp = gi;
      // A lone aircraft hears no peers, so the product ladder holds it ISOLATED and it may not accept
      // new tasks. Its lanes are therefore its PRE-LOADED plan, which isolation allows it to continue.
      if (M.n == 1) { l.owner = 0; l.st = 1; }
      M.lanes.push_back(l);
    }
  }
}
void allocate_lanes() {
  if (M.n == 1) return;
  for (auto& l : M.lanes) {
    if (l.st == 3 || l.owner < 0) continue;
    Uav& o = M.u[l.owner];
    double last = -1e9; for (int j = 0; j < M.n; ++j) if (j != l.owner) last = std::max(last, M.u[j].heard[l.owner]);
    double age = M.t - last;
    if (M.n == 1) age = 0;
    if (age <= 3 && o.alive) { l.lease_until = M.t + LEASE_S; continue; }
    if (H::MayReallocatePeerWork(age, l.lease_until - M.t)) {
      char w[120]; std::snprintf(w, sizeof w, "declared %s (silent %.0f s, lease expired)  lane released", H::ToString(H::ClassifyPeer(age)), age);
      bool seen = false; for (auto& p : M.pending_log) if (p.first == w && p.second == nm(l.owner)) seen = true;
      if (!seen) group_log(nm(l.owner), w);
      l.lost_from = l.owner; l.lost_at = last; l.owner = -1; l.st = 0;
      if (o.lane >= 0 && &M.lanes[o.lane] == &l) o.lane = -1;
    }
  }
  for (int gi = 0; gi < (M.do_split ? 2 : 1); ++gi) {
    std::vector<int> mem;
    for (int i : members(gi)) { Uav& a = M.u[i]; if (a.st == U_COMMLOST) continue; if (!a.ladder.permissions().may_accept_new_tasks) continue; mem.push_back(i); }
    std::vector<int> pool;
    for (int k = 0; k < (int)M.lanes.size(); ++k) { Lane& l = M.lanes[k]; if (l.grp != gi || l.st == 3 || l.st == 2) continue; if (l.owner >= 0 && std::find(mem.begin(), mem.end(), l.owner) == mem.end()) continue; pool.push_back(k); }
    // aircraft already flying a lane keep it; everyone else bids
    std::vector<int> free_;
    for (int i : mem) if (M.u[i].lane < 0 || M.lanes[M.u[i].lane].st != 2) free_.push_back(i);
    if (pool.empty() || free_.empty()) continue;
    std::vector<T::Task> tv;
    for (int k : pool) {
      T::Task t; t.id = (T::TaskId)(k + 1);
      t.location = PositionBelief(Eigen::Vector3d(M.lanes[k].x0, M.lanes[k].y0, 0), Eigen::Matrix3d::Identity() * 25.0);
      t.base_value = 10; t.service_time_s = std::fabs(M.lanes[k].y1 - M.lanes[k].y0) / CRUISE;
      t.req.domain_mask = T::kDomainAir; t.req.max_agent_position_sigma_m = 120.0; tv.push_back(t);
    }
    std::vector<T::CbbaAgent> ag; ag.reserve(free_.size());
    T::CbbaConfig cfg; cfg.max_bundle = 1;          // one lane at a time per aircraft
    for (size_t m = 0; m < free_.size(); ++m) {
      Uav& a = M.u[free_[m]];
      T::AgentState st; st.id = (T::AgentId)(m + 1); st.profile = &M.plane;
      st.position = PositionBelief(Eigen::Vector3d(a.x + a.ex, a.y + a.ey, 0), Eigen::Matrix3d::Identity() * (a.sigma * a.sigma));
      st.position.stamp.quality = ClockQuality::kMeshSynced;
      ag.emplace_back(st, &tv, free_.size(), &M.score, cfg);
    }
    for (int round = 0; round < 60; ++round) {
      for (auto& x : ag) x.BuildBundle();
      std::vector<T::ConsensusMessage> msg; for (auto& x : ag) msg.push_back(x.Publish());
      for (size_t r = 0; r < ag.size(); ++r) for (size_t s = 0; s < ag.size(); ++s) if (r != s && hears(free_[r], free_[s])) ag[r].Receive(msg[s], M.t);
      bool done = true; for (auto& x : ag) if (x.Tick() == T::ConvergenceOutcome::kInProgress) done = false;
      if (done) break;
    }
    for (size_t m = 0; m < free_.size(); ++m) {
      Uav& a = M.u[free_[m]]; auto ids = ag[m].BundleTaskIds();
      if (ids.empty()) continue;
      int k = (int)ids[0] - 1; Lane& l = M.lanes[k];
      if (l.owner != free_[m]) {
        if (l.lost_at >= 0) {
          M.last_realloc_s = M.t - l.lost_at;
          char w[120]; std::snprintf(w, sizeof w, "took lane %d from %s  %.0f s after it went silent", k + 1, nm(l.lost_from).c_str(), M.last_realloc_s);
          group_log(nm(free_[m]), w); l.lost_at = -1;
        }
        if (a.lane >= 0 && a.lane != k && M.lanes[a.lane].owner == free_[m] && M.lanes[a.lane].st != 2) { M.lanes[a.lane].owner = -1; M.lanes[a.lane].st = 0; }
        l.owner = free_[m]; l.st = 1; l.lease_until = M.t + LEASE_S; a.lane = k; a.lane_leg = 0;
      }
    }
  }
}
bool fly_search(int gi) {   // returns true when every lane of the group is done
  auto mem = members(gi);
  for (int i : mem) {
    Uav& a = M.u[i]; a.sx = -1;
    if (a.st == U_COMMLOST) { if (M.t - a.lost_link_at < 45) steer(a, a.x + std::cos(a.hd) * 1000, a.y + std::sin(a.hd) * 1000, CRUISE); else orbit(a, RDV, 900); continue; }
    if (a.st == U_REJOIN) a.st = U_ACTIVE;
    if (a.lane < 0 && M.n == 1) for (int k = 0; k < (int)M.lanes.size(); ++k) if (M.lanes[k].owner == i && M.lanes[k].st == 1) { a.lane = k; a.lane_leg = 0; break; }
    if (a.lane < 0 || M.lanes[a.lane].owner != i) { a.lane = -1; orbit(a, V2{AREA_X0 - 900, gi == 0 ? AREA_YM + 2000 : AREA_YM - 2000}, 600); continue; }
    Lane& l = M.lanes[a.lane];
    if (a.lane_leg == 0) { steer(a, l.x0, l.y0, CRUISE + 4); if (dist(a.x + a.ex, a.y + a.ey, l.x0, l.y0) < 200) { a.lane_leg = 1; l.st = 2; } }
    else { steer(a, l.x1, l.y1, CRUISE); if (dist(a.x + a.ex, a.y + a.ey, l.x1, l.y1) < 200) { l.st = 3; group_log(nm(i), "lane complete"); a.lane = -1; } }
  }
  for (auto& l : M.lanes) if (l.grp == gi && l.st != 3) return false;
  return true;
}

// ------------------------------------------------------------------ separation (product)
void separation() {
  for (int i = 0; i < M.n; ++i) {
    Uav& a = M.u[i]; if (!flying(a)) continue;
    T::SepPeer self; self.id = i + 1; self.pos = geo(a.x + a.ex, a.y + a.ey, a.alt);
    std::vector<T::SepPeer> peers;
    for (int j = 0; j < M.n; ++j) { if (j == i || !flying(M.u[j]) || !hears(i, j)) continue; T::SepPeer p; p.id = j + 1; p.pos = geo(M.u[j].x + M.u[j].ex, M.u[j].y + M.u[j].ey, M.u[j].alt); peers.push_back(p); }
    T::SeparationResult r = T::CheckSeparation(self, peers, 150.0);
    if (r.layer != a.layer) {
      if (r.layer > a.layer) { char w[80]; std::snprintf(w, sizeof w, "separation yield  climbing to layer %d (+%d m)", r.layer, r.layer * 40); group_log(nm(i), w); }
      a.layer = r.layer;
    }
    a.target_alt = r.target_alt_m > 0 ? r.target_alt_m : 150.0 + 40.0 * r.layer;
  }
}

// ------------------------------------------------------------------ events
void apply_event(int kind, int arg) {
  switch (kind) {
    case E_GPS_ON:  if (!M.gps_global) { M.gps_global = true; logf("EVENT  GPS unavailable across the area"); } break;
    case E_GPS_OFF: if (M.gps_global) { M.gps_global = false; logf("EVENT  GPS available again"); } break;
    case E_GPSZONE: M.gps_zone = true; logf("EVENT  GPS denied over the transit corridor"); break;
    case E_RADIO_ON:  if (!M.radio_degraded) { M.radio_degraded = true; logf("EVENT  radio links degraded  range and delivery cut"); } break;
    case E_RADIO_OFF: if (M.radio_degraded) { M.radio_degraded = false; logf("EVENT  radio links recovered"); } break;
    case E_CUT:  if (arg >= 0 && arg < M.n && flying(M.u[arg])) { M.u[arg].radio_fault_until = M.t + 80; logf("EVENT  %s radio fault  80 s", nm(arg).c_str()); } break;
    case E_LOSE: if (arg >= 0 && arg < M.n && flying(M.u[arg])) { M.u[arg].alive = false; M.u[arg].st = U_LOST; logf("EVENT  %s lost", nm(arg).c_str()); } break;
    case E_LEAVE: if (arg >= 0 && arg < M.n && M.u[arg].st == U_ACTIVE && M.g[M.u[arg].grp].leader != arg) { M.u[arg].st = U_LEFT; M.u[arg].left_until = M.t + 40; logf("EVENT  %s leaves formation  sensor check, 40 s", nm(arg).c_str()); } break;
    case E_FORM: { int gi = (arg >= 0 && arg < M.n && M.split_done && M.phase < P_RENDEZVOUS) ? M.u[arg].grp : 0; Form f = M.g[gi].form;
                   Form nf = f == F_WEDGE ? F_V : f == F_V ? F_LINE : f == F_LINE ? F_COLUMN : F_WEDGE;
                   if (f == F_SEARCH || f == F_RING) break; set_form(gi, nf, "(commanded)"); } break;
  }
}
void run_script() {
  for (auto& e : M.script) if (!e.done && (int)M.phase == e.phase && M.t - M.phase_t0 >= e.after) { e.done = true; apply_event(e.kind, e.arg); }
}

void request(int id, const char* text) { if (M.pending == id) return; M.pending = id; M.decision = text; logf("AWAITING OPERATOR  %s", text); }

// ------------------------------------------------------------------ mission phases (demonstration script)
void mission() {
  auto all = [](int gi) { return members(gi); };
  switch (M.phase) {
    case P_LAUNCH: {
      for (int i = 0; i < M.n; ++i) if (M.u[i].st == U_READY && M.t - M.last_launch >= 3.0) {
        Uav& a = M.u[i]; a.st = U_ACTIVE; a.spd = 18; a.target_alt = 150; M.last_launch = M.t; group_log(nm(i), "launched"); break;
      }
      std::vector<int> up; for (int i = 0; i < M.n; ++i) if (flying(M.u[i])) up.push_back(i);
      if (M.n == 1) { if (!up.empty()) { set_phase(P_TRANSIT); M.g[0].form = F_COLUMN; } break; }
      double r; ring_targets(up, ASSEMBLE, r);
      bool ready = true; for (int i = 0; i < M.n; ++i) if (M.u[i].st == U_READY) ready = false;
      if (ready) set_phase(P_ASSEMBLY);
      break;
    }
    case P_ASSEMBLY: {
      auto mem = all(0); double r; ring_targets(mem, ASSEMBLE, r);
      double err = 0; for (int i : mem) err += dist(M.u[i].x, M.u[i].y, M.u[i].sx, M.u[i].sy); err /= std::max<size_t>(1, mem.size());
      if ((err < 500 && M.t - M.phase_t0 > 20) || M.t - M.phase_t0 > 150) { set_phase(P_FORMATION); set_form(0, F_WEDGE, "(swarm assembled)"); }
      break;
    }
    case P_FORMATION: {
      fly_formation(0);
      double err = 0; int c = 0; for (int i : all(0)) if (M.u[i].sx >= 0) { err += dist(M.u[i].x, M.u[i].y, M.u[i].sx, M.u[i].sy); ++c; }
      if ((c && err / c < 220 && M.t - M.phase_t0 > 15) || M.t - M.phase_t0 > 90) set_phase(P_TRANSIT);
      break;
    }
    case P_TRANSIT: {
      Group& G = M.g[0];
      if (G.wp == 1 && G.form != F_COLUMN && M.n > 1) set_form(0, F_COLUMN, "(narrow corridor W1-W2)");
      if (G.wp == 2 && G.form == F_COLUMN) set_form(0, F_V, "(corridor cleared)");
      bool at_end = fly_formation(0);
      if (at_end) {
        if (M.do_search && M.do_split) {
          G.hold = true; G.hold_at = W3;
          request(1, "Commence search: split into Group A (U01-U10) and Group B (U11-U20)?");
        } else if (M.do_search) { build_lanes(); set_form(0, F_SEARCH, "(search pattern)"); set_phase(P_SEARCH); }
        else { G.hold = true; G.hold_at = W3; request(2, "Route complete. Return to base?"); }
      }
      break;
    }
    case P_SPLIT: {
      bool a = fly_formation(0), b = fly_formation(1);
      if (a && b) { build_lanes(); set_form(0, F_SEARCH, "(search pattern)"); set_form(1, F_SEARCH, "(search pattern)"); set_phase(P_SEARCH); M.next_alloc = 0; }
      break;
    }
    case P_SEARCH: {
      if (M.t >= M.next_alloc) { allocate_lanes(); M.next_alloc = M.t + 2.0; }
      bool da = fly_search(0), db = M.do_split ? fly_search(1) : true;
      if (da && db) {
        logf("SEARCH COMPLETE  every lane flown");
        if (M.n == 1) { M.g[0].path = {W4, BASE}; M.g[0].wp = 0; set_form(0, F_COLUMN, "(return)"); set_phase(P_RTB); }
        else { set_phase(P_RENDEZVOUS); for (int gi = 0; gi < 2; ++gi) M.g[gi].form = F_RING; }
      }
      break;
    }
    case P_RENDEZVOUS: {
      std::vector<int> mem; for (int i = 0; i < M.n; ++i) if (flying(M.u[i]) && M.u[i].st != U_COMMLOST) mem.push_back(i);
      double r; ring_targets(mem, RDV, r);
      for (int i = 0; i < M.n; ++i) if (M.u[i].st == U_COMMLOST) orbit(M.u[i], RDV, 1100);
      double err = 0; for (int i : mem) err = std::max(err, dist(M.u[i].x, M.u[i].y, M.u[i].sx, M.u[i].sy));
      if ((err < 450 && M.t - M.phase_t0 > 20) || M.t - M.phase_t0 > 160) {
        for (int i = 0; i < M.n; ++i) M.u[i].grp = 0;
        M.g[1].active = false; M.g[0].hold = false; M.g[0].path = {V2{RDV.x - 2500, RDV.y - 600}}; M.g[0].wp = 0; M.g[0].leader = -1;
        set_form(0, F_WEDGE, "(groups merged)"); logf("RENDEZVOUS  Group A and Group B rejoined  %zu UAVs", mem.size());
        set_phase(P_REFORM);
      }
      break;
    }
    case P_REFORM: {
      bool at = fly_formation(0);
      if (at || M.t - M.phase_t0 > 70) { M.g[0].hold = true; M.g[0].hold_at = M.g[0].path.back(); request(2, "Search complete. Return to base?"); }
      break;
    }
    case P_RTB: {
      Group& G = M.g[0];
      if (G.wp >= 1 && G.form != F_COLUMN && M.n > 1) set_form(0, F_COLUMN, "(landing sequence)");
      static bool landing = false; static double last_land = -1e9;
      if (M.phase_t0 == M.t) landing = false;
      if (!landing) { if (fly_formation(0)) { landing = true; logf("LANDING SEQUENCE  three on approach, one landing every 3 s"); } }
      if (landing) {
        // the three nearest aircraft are on approach at once; the rest hold in a stack around the base
        std::vector<std::pair<double, int>> order;
        for (int i = 0; i < M.n; ++i) if (flying(M.u[i])) order.push_back({dist(M.u[i].x, M.u[i].y, BASE.x, BASE.y), i});
        std::sort(order.begin(), order.end());
        for (size_t r = 0; r < order.size(); ++r) {
          int i = order[r].second; Uav& a = M.u[i]; a.sx = -1;
          if (r < 3) { steer(a, BASE.x, BASE.y, 22); a.target_alt = 0;
            if (dist(a.x, a.y, BASE.x, BASE.y) < 300 && M.t - last_land >= 3.0) { a.st = U_LANDED; a.alt = 0; a.spd = 0; last_land = M.t; group_log(nm(i), a.lost_link_at > 0 && M.t - a.lost_link_at < 200 ? "landed (comms-lost return)" : "landed"); } }
          else orbit(a, BASE, 1000 + 60 * (i % 5));
        }
      }
      for (int i = 0; i < M.n; ++i) { Uav& a = M.u[i]; if (a.st == U_COMMLOST && !landing && dist(a.x, a.y, BASE.x, BASE.y) < 1500) orbit(a, BASE, 1500); }
      bool any = false; for (int i = 0; i < M.n; ++i) if (flying(M.u[i])) any = true;
      if (!any) { set_phase(P_COMPLETE); M.complete_at = M.t; logf("MISSION COMPLETE"); }
      break;
    }
    case P_COMPLETE: break;
  }
}

void confirm(int id) {
  if (M.pending != id || id == 0) return;
  logf("OPERATOR CONFIRMED  %s", M.decision.c_str());
  M.pending = 0; M.decision.clear();
  if (id == 1) {
    for (int i = 0; i < M.n; ++i) M.u[i].grp = i < M.n / 2 ? 0 : 1;
    M.g[0].hold = false; M.g[1].active = true; M.g[1].hold = false;
    M.g[0].path = {V2{AREA_X0 - 600, AREA_YM + 2000}}; M.g[0].wp = 0; M.g[0].leader = -1;
    M.g[1].path = {V2{AREA_X0 - 600, AREA_YM - 2000}}; M.g[1].wp = 0; M.g[1].leader = -1;
    M.g[0].form = F_LINE; M.g[1].form = F_LINE; M.split_done = true;
    logf("SPLIT  Group A (%d UAVs) north, Group B (%d UAVs) south  both in LINE", (int)members(0).size(), (int)members(1).size());
    set_phase(P_SPLIT);
  } else if (id == 2) {
    M.g[0].hold = false; M.g[0].path = {W4, BASE}; M.g[0].wp = 0; M.g[0].leader = -1;
    set_phase(P_RTB);
  }
}

void step() {
  run_script();
  radio();
  for (int i = 0; i < M.n; ++i) if (flying(M.u[i])) { nav(M.u[i]); health(M.u[i]); }
  if (M.t >= M.next_sep) { separation(); M.next_sep = M.t + 1.0; }
  mission();
  flush_log();
  M.t += DT;
}

uint64_t fnv(uint64_t h, const void* p, size_t n) { const uint8_t* b = (const uint8_t*)p; for (size_t i = 0; i < n; ++i) { h ^= b[i]; h *= 1099511628211ull; } return h; }
double snap_buf[MAXV * 24 + MAXV * MAXV + 64 * 7 + 8];
double meta_buf[32];
double geom_buf[64];
}  // namespace

extern "C" {
__attribute__((export_name("m_init")))    void m_init(int scenario, double seed) { reset(scenario, (uint64_t)seed); }
__attribute__((export_name("m_step")))    void m_step(int k) { for (int i = 0; i < k; ++i) step(); }
__attribute__((export_name("m_event")))   void m_event(int kind, int arg) { if (kind == 20) confirm(arg); else apply_event(kind, arg); }
__attribute__((export_name("m_n")))       int m_n() { return M.n; }
__attribute__((export_name("m_nlanes")))  int m_nlanes() { return (int)M.lanes.size(); }
__attribute__((export_name("m_snapshot"))) double* m_snapshot() {
  int o = 0;
  for (int i = 0; i < M.n; ++i) {
    const Uav& a = M.u[i]; int links = 0, alive = 0;
    for (int j = 0; j < M.n; ++j) if (j != i && flying(M.u[j])) { ++alive; links += M.t - a.heard[j] <= 3; }
    double v[24] = {a.x, a.y, a.alt, a.hd, a.spd, (double)a.grp, M.g[a.grp].leader == i ? 1.0 : 0.0, (double)a.st, a.sigma, (double)a.src,
                    (double)a.rung, (double)a.regime, alive ? (double)links / alive : 1.0, a.tx, a.ty, a.sx, a.sy, a.vx, a.vy, (double)a.layer,
                    (double)a.lane, a.x + a.ex, a.y + a.ey, (double)a.slot};
    std::memcpy(snap_buf + o, v, sizeof v); o += 24;
  }
  for (int i = 0; i < M.n * M.n; ++i) snap_buf[o++] = M.link[(i / M.n) * MAXV + (i % M.n)];
  for (auto& l : M.lanes) { snap_buf[o++] = l.x0; snap_buf[o++] = l.y0; snap_buf[o++] = l.x1; snap_buf[o++] = l.y1; snap_buf[o++] = l.grp; snap_buf[o++] = l.st; snap_buf[o++] = l.owner; }
  return snap_buf;
}
__attribute__((export_name("m_meta"))) double* m_meta() {
  int act = 0, rej = 0, cl = 0, lost = 0, landed = 0, left = 0, na = 0, nb = 0;
  for (int i = 0; i < M.n; ++i) { const Uav& a = M.u[i];
    act += a.st == U_ACTIVE; rej += a.st == U_REJOIN; cl += a.st == U_COMMLOST; lost += a.st == U_LOST; landed += a.st == U_LANDED; left += a.st == U_LEFT;
    if (flying(a)) { if (a.grp == 0) ++na; else ++nb; } }
  double m[32] = {M.t, (double)M.phase, (double)M.g[0].form, (double)M.g[1].form, (double)na, (double)nb, (double)M.g[0].leader, (double)M.g[1].leader,
                  (double)act, (double)rej, (double)cl, (double)lost, (double)landed, (double)left, M.gps_zone ? 1.0 : 0.0, M.gps_global ? 1.0 : 0.0,
                  M.radio_degraded ? 1.0 : 0.0, (double)M.pending, M.complete_at, (double)M.n, M.split_done ? 1.0 : 0.0, M.g[1].active ? 1.0 : 0.0,
                  M.last_realloc_s, (double)M.scenario, spacing_scale(0), spacing_scale(1), 0, 0, 0, 0, 0, 0};
  std::memcpy(meta_buf, m, sizeof m); return meta_buf;
}
__attribute__((export_name("m_geom"))) double* m_geom() {
  double gm[] = {BASE.x, BASE.y, ASSEMBLE.x, ASSEMBLE.y, W1.x, W1.y, W2.x, W2.y, W3.x, W3.y, RDV.x, RDV.y, W4.x, W4.y,
                 AREA_X0, AREA_Y0, AREA_X1, AREA_Y1, AREA_YM, GPS_X0, GPS_Y0, GPS_X1, GPS_Y1};
  std::memcpy(geom_buf, gm, sizeof gm); return geom_buf;
}
__attribute__((export_name("m_decision_ptr"))) const char* m_decision_ptr() { return M.decision.c_str(); }
__attribute__((export_name("m_decision_len"))) int m_decision_len() { return (int)M.decision.size(); }
__attribute__((export_name("m_log_ptr")))  const char* m_log_ptr() { return M.log.c_str(); }
__attribute__((export_name("m_log_len")))  int m_log_len() { return (int)M.log.size(); }
__attribute__((export_name("m_log_clear"))) void m_log_clear() { M.log.clear(); }
__attribute__((export_name("m_hash"))) double m_hash() {
  uint64_t h = 1469598103934665603ull;
  for (int i = 0; i < M.n; ++i) { const Uav& a = M.u[i]; int64_t q[6] = {std::llround(a.x * 10), std::llround(a.y * 10), std::llround(a.sigma * 10), (int64_t)a.st, a.rung, a.layer}; h = fnv(h, q, sizeof q); }
  for (auto& l : M.lanes) { int32_t q[2] = {l.st, l.owner}; h = fnv(h, q, sizeof q); }
  int32_t ph = (int32_t)M.phase; h = fnv(h, &ph, sizeof ph);
  return (double)(h >> 11);
}
}
