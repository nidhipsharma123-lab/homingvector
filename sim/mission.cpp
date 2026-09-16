// Homingvector site: CROSS-DOMAIN SWARM MISSION engine around the TurtleShield decision core.
// 70 fixed-wing aircraft, 6 ground robots and 4 surface boats in the full scenarios.
//
// WHAT IS PRODUCT CODE AND WHAT IS NOT -- stated first because the page makes claims from it.
//   PRODUCT (compiled unchanged from the TurtleShield repo at the sha in provenance.json):
//     task::CbbaAgent + TimeDiscountedScore + CheckEligibility
//                       who takes which search lane or station, ACROSS DOMAINS (air may cover a ground
//                       or water station; a robot never gets a water station), and re-tasking after a loss
//     task::PlanRing    assembly / hold / relay / rendezvous loiter-ring slots
//     task::CheckSeparation   separation monitor and climb-to-layer yields
//     health::DegradationLadder, PermissionsFor   per-vehicle degraded modes; formation spacing is
//                       widened by the ladder's own geofence_margin_scale
//     health::QuorumPolicy, ClassifyPeer, MayReallocatePeerWork, PolicyForIsolation
//     nav::FuseCooperative   peer-aided navigation while GPS is unavailable
//     the fixed-wing / rover / boat capability profiles (tests/task_fixtures.h)
//   DEMONSTRATION CODE (this file, NOT product): mission phases, wedge / V / line / column geometry,
//     leader-follower steering, ground and water movement, the radio and GPS models, scenario scripts.
//     TurtleShield ships no wedge/V/line/column formation logic; the page must never say it does.
//
// Deterministic: one xorshift64* stream, fixed step, no clock, no <random> distributions, and no
// function-static state (it survived m_init once and broke every mission after the first).
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
constexpr int MAXV = 80;
constexpr double PI = 3.141592653589793;
constexpr double CRUISE = 22.0;
constexpr double SPACING = 240.0;           // > product h_min 200 m in every slot pattern below
constexpr double LEASE_S = 20.0;
// DEMONSTRATION steering gains, tuned by tools/tune_mission.mjs. Only site-owned steering is tuned.
double TUNE[6] = {0.03, 350.0, 0.01, 350.0, 0.03, 0.55};

enum Kind { K_AIR = 0, K_GND = 1, K_SEA = 2 };
enum Phase { P_LAUNCH, P_ASSEMBLY, P_FORMATION, P_TRANSIT, P_SPLIT, P_SEARCH, P_RENDEZVOUS, P_REFORM, P_RTB, P_COMPLETE };
const char* PHASE[] = {"LAUNCH", "ASSEMBLY", "FORMATION", "TRANSIT", "SPLIT", "SEARCH", "RENDEZVOUS", "REFORM", "RETURN", "COMPLETE"};
enum Form { F_WEDGE, F_V, F_LINE, F_COLUMN, F_SEARCH, F_RING };
const char* FORM[] = {"WEDGE", "V", "LINE", "COLUMN", "DISTRIBUTED SEARCH", "LOITER RING"};
enum UState { U_READY, U_ACTIVE, U_LEFT, U_REJOIN, U_COMMLOST, U_LOST, U_LANDED };

struct V2 { double x, y; };
constexpr V2 BASE{2000, 2000}, ASSEMBLE{5600, 3800}, W1{9500, 5200}, W2{13500, 5400}, W3{17000, 7000},
             RDV{15600, 11000}, W4{9000, 9000}, FOB{15200, 2600}, HARBOR{15000, 12600},
             GSTAGE{18200, 3600}, SSTAGE{18200, 11400};
constexpr double AREA_X0 = 19000, AREA_X1 = 25200, AREA_Y0 = 3000, AREA_Y1 = 11000, AREA_YM = 7000;
constexpr double WATER_X0 = 14200, WATER_Y0 = 9000;            // water: x > WATER_X0 and y > WATER_Y0
constexpr double GPS_X0 = 8000, GPS_X1 = 15000, GPS_Y0 = 2500, GPS_Y1 = 9000;
bool on_water(double x, double y) { return x > WATER_X0 && y > WATER_Y0; }

struct Uav {
  int id = 0; Kind kind = K_AIR; int grp = 0; UState st = U_READY; bool alive = true;
  double x = 0, y = 0, alt = 0, hd = 0, spd = 0, vx = 0, vy = 0;
  double ex = 0, ey = 0, sigma = 3; NavSource src = NavSource::kGnss;
  double tx = 0, ty = 0, sx = -1, sy = -1;
  double radio_fault_until = -1, left_until = -1, lost_link_at = -1;
  double heard[MAXV]; H::DegradationLadder ladder; H::QuorumPolicy quorum;
  int rung = 0, regime = 3, logged_rung = 0; double rung_since = 0;
  int layer = 0; double target_alt = 150; int lane = -1; int lane_leg = 0; double dwell = 0;
  int slot = -1; bool reserve = false;
};
// lanes (air sweeps) and stations (points to hold): the same product task, different domains
struct Lane { double x0, y0, x1, y1; int grp; uint8_t domain; bool station; int st = 0; int owner = -1; double lease_until = 0; double lost_at = -1; int lost_from = -1; };
struct Group { bool active = false; int leader = -1; Form form = F_WEDGE; std::vector<V2> path; int wp = 0; bool hold = false; V2 hold_at{0, 0}; };
struct Ev { int phase; double after; int kind; int arg; bool done = false; };

struct Mission {
  Rng rng; int scenario = 7; int n = 0, nfw = 20, nugv = 0, nusv = 0; bool do_split = true, do_search = true;
  double t = 0, phase_t0 = 0; Phase phase = P_LAUNCH;
  Uav u[MAXV]; Group g[2]; std::vector<Lane> lanes; std::vector<Ev> script;
  bool gps_zone = false, gps_global = false, radio_degraded = false;
  int pending = 0; std::string decision; double complete_at = -1; double last_launch = -1e9;
  double next_alloc = 0, next_sep = 0; std::string log; bool split_done = false;
  uint8_t link[MAXV * MAXV]; double last_realloc_s = -1;
  CapabilityProfile plane, rover, boat; T::TimeDiscountedScore score; LocalFrame frame;
  std::vector<std::pair<std::string, std::string>> pending_log;
  double slot_err_sum = 0; long slot_err_n = 0; int sep_yields = 0;
  bool landing = false; double last_land = -1e9;
} M;

// ------------------------------------------------------------------ log (grouped per step)
void logf(const char* fmt, ...) __attribute__((format(printf, 1, 2)));
void logf(const char* fmt, ...) {
  char b[320]; va_list ap; va_start(ap, fmt); std::vsnprintf(b, sizeof b, fmt, ap); va_end(ap);
  char tb[24]; int s = (int)M.t; std::snprintf(tb, sizeof tb, "T+%02d:%02d ", s / 60, s % 60);
  M.log += tb; M.log += b; M.log += '\n';
  if (M.log.size() > 24000) M.log.erase(0, M.log.size() - 18000);
}
std::string nm(int i) {
  char b[8]; const Uav& a = M.u[i];
  if (a.kind == K_AIR) std::snprintf(b, sizeof b, "U%02d", i + 1);
  else if (a.kind == K_GND) std::snprintf(b, sizeof b, "G%02d", i - M.nfw + 1);
  else std::snprintf(b, sizeof b, "S%02d", i - M.nfw - M.nugv + 1);
  return b;
}
void group_log(const std::string& who, const std::string& what) {
  for (auto& p : M.pending_log) if (p.first == what) { p.second += " " + who; return; }
  M.pending_log.push_back({what, who});
}
void flush_log() {
  for (auto& p : M.pending_log) {
    int c = 1; for (char ch : p.second) c += ch == ' ';
    if (c > 4) logf("%d vehicles  %s", c, p.first.c_str()); else logf("%s  %s", p.second.c_str(), p.first.c_str());
  }
  M.pending_log.clear();
}

double dist(double ax, double ay, double bx, double by) { return std::hypot(ax - bx, ay - by); }
double wrap(double a) { return std::remainder(a, 2 * PI); }
bool flying(const Uav& a) { return a.alive && (a.st == U_ACTIVE || a.st == U_LEFT || a.st == U_REJOIN || a.st == U_COMMLOST); }
bool in_gps_zone(double x, double y) { return M.gps_global || (M.gps_zone && x > GPS_X0 && x < GPS_X1 && y > GPS_Y0 && y < GPS_Y1); }
GeoPoint geo(double x, double y, double z) { return M.frame.FromEnu(Eigen::Vector3d(x, y, z), AltitudeFrame::kRelativeHomeM); }
const CapabilityProfile* profile_of(const Uav& a) { return a.kind == K_AIR ? &M.plane : a.kind == K_GND ? &M.rover : &M.boat; }

void set_phase(Phase p) { if (p == M.phase) return; logf("PHASE  %s -> %s", PHASE[M.phase], PHASE[p]); M.phase = p; M.phase_t0 = M.t; }
void set_form(int gi, Form f, const char* why) { if (M.g[gi].form == f) return; logf("GROUP %c  formation %s -> %s  %s", 'A' + gi, FORM[M.g[gi].form], FORM[f], why); M.g[gi].form = f; }

// ------------------------------------------------------------------ scenarios
void script(int phase, double after, int kind, int arg) { Ev e; e.phase = phase; e.after = after; e.kind = kind; e.arg = arg; M.script.push_back(e); }
enum { E_GPS_ON = 1, E_GPS_OFF, E_RADIO_ON, E_RADIO_OFF, E_CUT, E_LOSE, E_LEAVE, E_FORM, E_GPSZONE };

void reset(int scenario, uint64_t seed) {
  M.~Mission(); new (&M) Mission();
  M.rng.seed(seed); M.scenario = scenario;
  M.plane = turtleshield_test::FixtureFixedWing("fw"); M.rover = turtleshield_test::FixtureRover("ugv"); M.boat = turtleshield_test::FixtureBoat("usv");
  GeoPoint o; o.lat_deg = 20.0; o.lon_deg = 10.0; M.frame = LocalFrame(o);
  M.nfw = 70; M.nugv = 6; M.nusv = 4;
  switch (scenario) {
    case 1: M.nfw = 1; M.nugv = 0; M.nusv = 0; M.do_split = false;
            script(P_TRANSIT, 40, E_GPS_ON, 0); script(P_SEARCH, 30, E_GPS_OFF, 0); break;
    case 2: M.nfw = 8; M.nugv = 0; M.nusv = 0; M.do_split = false; M.do_search = false;
            script(P_TRANSIT, 55, E_LEAVE, 4); break;
    case 3: break;
    case 4: script(P_LAUNCH, 0, E_GPSZONE, 0); break;
    case 5: script(P_TRANSIT, 30, E_RADIO_ON, 0); script(P_TRANSIT, 60, E_CUT, 6); script(P_SEARCH, 40, E_RADIO_OFF, 0); break;
    case 6: script(P_TRANSIT, 70, E_LOSE, 0); script(P_SEARCH, 60, E_LOSE, 3); script(P_SEARCH, 110, E_LOSE, 13);
            script(P_SEARCH, 90, E_LOSE, 71); break;                                   // a ground robot too
    default: script(P_LAUNCH, 0, E_GPSZONE, 0); script(P_TRANSIT, 25, E_RADIO_ON, 0); script(P_TRANSIT, 45, E_CUT, 6);
             script(P_TRANSIT, 90, E_LEAVE, 4); script(P_SEARCH, 20, E_RADIO_OFF, 0); script(P_SEARCH, 70, E_LOSE, 3);
             script(P_SEARCH, 100, E_LOSE, 72); script(P_REFORM, 5, E_FORM, 0); break;
  }
  M.n = M.nfw + M.nugv + M.nusv;
  for (int i = 0; i < M.n; ++i) {
    Uav& a = M.u[i]; a.id = i;
    a.kind = i < M.nfw ? K_AIR : i < M.nfw + M.nugv ? K_GND : K_SEA;
    for (int j = 0; j < MAXV; ++j) a.heard[j] = -1e9;
    if (a.kind == K_AIR) { a.x = BASE.x - 700 + (i % 10) * 140; a.y = BASE.y - 700 + (i / 10) * 140; a.hd = .6; }
    else if (a.kind == K_GND) { int k = i - M.nfw; a.x = FOB.x - 150 + (k % 3) * 150; a.y = FOB.y - 100 + (k / 3) * 150; a.hd = .4; a.target_alt = 0; a.grp = 1; }
    else { int k = i - M.nfw - M.nugv; a.x = HARBOR.x - 200 + k * 140; a.y = HARBOR.y; a.hd = .0; a.target_alt = 0; a.grp = 0; }
  }
  M.g[0].active = true; M.g[0].form = F_RING; M.g[0].path = {W1, W2, W3};
  std::memset(M.link, 0, sizeof M.link);
  logf("MISSION  scenario %d  %d fixed-wing  %d ground  %d surface  seed %llu", scenario, M.nfw, M.nugv, M.nusv, (unsigned long long)seed);
}

// ------------------------------------------------------------------ radio (mesh relay)
double range_of(const Uav& a) { double r = a.kind == K_AIR ? 6000 : a.kind == K_GND ? 3500 : 4500; return M.radio_degraded ? r * .55 : r; }
void radio() {
  std::memset(M.link, 0, sizeof M.link);
  const double drop = M.radio_degraded ? .35 : .02;
  for (int i = 0; i < M.n; ++i) for (int j = i + 1; j < M.n; ++j) {
    Uav& a = M.u[i]; Uav& b = M.u[j];
    if (!flying(a) || !flying(b)) continue;
    if (M.t < a.radio_fault_until || M.t < b.radio_fault_until) continue;
    if (dist(a.x, a.y, b.x, b.y) > std::min(range_of(a), range_of(b)) * (a.kind == K_AIR || b.kind == K_AIR ? 1.0 : .8)) continue;
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
  double drift = a.kind == K_AIR ? .25 : .08;
  a.ex += M.rng.n() * drift; a.ey += M.rng.n() * drift;
  a.sigma = std::min(a.sigma + (a.kind == K_AIR ? .9 : .3) * DT, 800.0); a.src = NavSource::kDeadReckon;
  std::vector<N::RelativeFix> fixes;
  for (int j = 0; j < M.n; ++j) {
    Uav& p = M.u[j];
    if (j == a.id || !flying(p) || p.src != NavSource::kGnss || !hears(a.id, j)) continue;
    double r = dist(a.x, a.y, p.x, p.y); if (r > 4000) continue;
    N::RelativeFix f; f.from_node = j + 1; double e = 10 + .01 * r;
    f.observed_position = Eigen::Vector3d(a.x + p.ex + M.rng.n() * e, a.y + p.ey + M.rng.n() * e, 0);
    f.covariance = Eigen::Matrix3d::Identity() * (e * e + 9); fixes.push_back(f);
    if (fixes.size() >= 6) break;
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
  for (int j = 0; j < M.n; ++j) { if (j == a.id || M.u[j].st == U_READY) continue; double age = M.t - a.heard[j]; if (age <= 3) ++live; else if (age < 45) worst = std::max(worst, age); }
  H::HealthInputs in; in.live_peers = live; in.worst_peer_age_s = worst; in.nav_source = a.src; in.position_sigma_m = a.sigma;
  in.clock_quality = a.src == NavSource::kGnss ? ClockQuality::kGpsSynced : ClockQuality::kMeshSynced;
  H::Rung was = a.ladder.rung(); a.ladder.Update(in);
  if (a.ladder.rung() != was) a.rung_since = M.t;
  a.rung = (int)a.ladder.rung();
  if (a.rung != a.logged_rung && M.t - a.rung_since >= 1.0) {
    group_log(nm(a.id), std::string(H::ToString((H::Rung)a.logged_rung)) + " -> " + H::ToString(a.ladder.rung())); a.logged_rung = a.rung;
  }
  a.quorum.Update(live, true, M.t); a.regime = (int)a.quorum.regime();
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

// ------------------------------------------------------------------ movement
void steer(Uav& a, double px, double py, double want_spd) {
  double bx = a.x + a.ex, by = a.y + a.ey;
  double want = std::atan2(py - by, px - bx), turn = wrap(want - a.hd);
  double maxr = (a.kind == K_AIR ? .32 : a.kind == K_GND ? 1.0 : .4) * DT;
  a.hd = wrap(a.hd + std::max(-maxr, std::min(maxr, turn)));
  if (a.kind == K_AIR) want_spd = std::max(14.0, std::min(32.0, want_spd));
  else { double vmax = a.kind == K_GND ? 7.0 : 9.0; double d = dist(bx, by, px, py); want_spd = std::max(0.0, std::min({vmax, want_spd, d * .15})); }
  double acc = a.kind == K_AIR ? 2.0 : 1.2;
  a.spd += std::max(-acc * DT, std::min(acc * DT, want_spd - a.spd));
  a.vx = std::cos(a.hd) * a.spd; a.vy = std::sin(a.hd) * a.spd;
  double nx = a.x + a.vx * DT, ny = a.y + a.vy * DT;
  // domain: robots stay on land, boats on water (a steering constraint, not a planner)
  if (a.kind == K_GND && on_water(nx, ny)) { nx = a.x; ny = std::min(a.y, WATER_Y0 - 60); a.spd *= .5; }
  if (a.kind == K_SEA && !on_water(nx, ny)) { nx = std::max(a.x, WATER_X0 + 60); ny = std::max(a.y, WATER_Y0 + 60); a.spd *= .5; }
  a.x = nx; a.y = ny;
  if (a.kind == K_AIR) a.alt += std::max(-3.0 * DT, std::min(3.0 * DT, a.target_alt - a.alt));
  a.tx = px; a.ty = py;
}
void orbit(Uav& a, V2 c, double r) {
  double ang = std::atan2(a.y - c.y, a.x - c.x) + 700.0 / r * .6;
  steer(a, c.x + std::cos(ang) * r, c.y + std::sin(ang) * r, CRUISE);
}
// ring slots from the PRODUCT's PlanRing, rotating slower than cruise so aircraft can catch them
void ring_targets(const std::vector<int>& ids, V2 c) {
  if (ids.empty()) return;
  std::vector<T::AssignAgent> ag;
  for (int i : ids) { T::AssignAgent x; x.id = (T::AgentId)(i + 1); x.position = geo(M.u[i].x, M.u[i].y, 0); ag.push_back(x); }
  T::RingConfig cfg; cfg.min_chord_m = 260; cfg.radius_m = std::max(700.0, T::MinRadiusForAgents((int)ids.size(), 260) + 60);
  cfg.align_to_fleet = false; cfg.phase_offset_rad = std::fmod(M.t * TUNE[5] * CRUISE / cfg.radius_m, 2 * PI);
  T::RingPlan plan = T::PlanRing(ag, geo(c.x, c.y, 0), cfg);
  if (!plan.ok) { for (int i : ids) orbit(M.u[i], c, cfg.radius_m); return; }
  for (int i : ids) {
    const T::RingSlot* s = plan.For((T::AgentId)(i + 1));
    if (!s) { orbit(M.u[i], c, cfg.radius_m); continue; }
    Eigen::Vector3d e = M.frame.ToEnu(s->point);
    double ang = std::atan2(e.y() - c.y, e.x() - c.x) + .35;
    Uav& a = M.u[i]; a.sx = e.x(); a.sy = e.y();
    double d = dist(a.x, a.y, e.x(), e.y());
    if (d > TUNE[3]) steer(a, e.x(), e.y(), CRUISE + std::min(9.0, d * .01));
    else steer(a, c.x + std::cos(ang) * cfg.radius_m, c.y + std::sin(ang) * cfg.radius_m, TUNE[5] * CRUISE + d * TUNE[4]);
  }
}

// ------------------------------------------------------------------ groups, leaders, formation
std::vector<int> air_members(int gi) { std::vector<int> v; for (int i = 0; i < M.nfw; ++i) if (M.u[i].grp == gi && flying(M.u[i])) v.push_back(i); return v; }
std::vector<int> all_members(int gi) { std::vector<int> v; for (int i = 0; i < M.n; ++i) if (M.u[i].grp == gi && flying(M.u[i])) v.push_back(i); return v; }
void elect(int gi) {
  int old = M.g[gi].leader, best = -1;
  for (int i : air_members(gi)) if (M.u[i].st == U_ACTIVE || M.u[i].st == U_REJOIN) { best = i; break; }
  if (best != old) { if (old >= 0 && best >= 0) logf("GROUP %c  leader %s -> %s", 'A' + gi, nm(old).c_str(), nm(best).c_str()); M.g[gi].leader = best; }
}
double spacing_scale(int gi) { double s = 1.0; for (int i : air_members(gi)) s = std::max(s, H::PermissionsFor(M.u[i].ladder.rung()).geofence_margin_scale); return s; }
V2 slot_offset(Form f, int k, double S) {
  int r = (k + 1) / 2; double side = (k % 2) ? -1 : 1;
  switch (f) {
    case F_WEDGE: { int row = 1, used = 0; while (used + row + 1 < k) { used += row + 1; ++row; } int j = k - used - 1; return {row * S * .95, (j - row / 2.0) * S}; }
    case F_V:      return {r * S * .8, side * r * S};
    case F_LINE:   return {((r - 1) / 12) * S * .95, side * (1 + (r - 1) % 12) * S};   // line abreast, 24 per rank
    case F_COLUMN: return {((k + 1) / 2) * S * .95, ((k % 2) ? -.55 : .55) * S};        // staggered double column
    default:       return {0, 0};
  }
}
bool fly_formation(int gi) {
  Group& G = M.g[gi]; elect(gi);
  if (G.leader < 0) return false;
  auto mem = air_members(gi); double S = SPACING * spacing_scale(gi);
  Uav& L = M.u[G.leader];
  if (G.hold) { ring_targets(mem, G.hold_at); for (int i : mem) M.u[i].slot = -1; return false; }
  bool arrived = false;
  if (G.wp < (int)G.path.size()) {
    V2 w = G.path[G.wp];
    double lag = 0; int cnt = 0;
    for (int i : mem) if (i != G.leader && M.u[i].sx >= 0) { lag += dist(M.u[i].x, M.u[i].y, M.u[i].sx, M.u[i].sy); ++cnt; }
    double spd = CRUISE - std::min(6.0, cnt ? lag / cnt * TUNE[2] : 0);
    steer(L, w.x, w.y, spd); L.sx = -1;
    if (dist(L.x, L.y, w.x, w.y) < 450) { G.wp++; if (G.wp >= (int)G.path.size()) arrived = true; }
  } else arrived = true;
  if (arrived) orbit(L, G.path.empty() ? V2{L.x, L.y} : G.path.back(), 700);
  int k = 0; double fx = std::cos(L.hd), fy = std::sin(L.hd);
  for (int i : mem) {
    if (i == G.leader) continue;
    Uav& a = M.u[i]; ++k; a.slot = k;
    if (a.st == U_COMMLOST) { if (M.t - a.lost_link_at < 45) steer(a, a.x + std::cos(a.hd) * 1000, a.y + std::sin(a.hd) * 1000, CRUISE); else steer(a, BASE.x, BASE.y, CRUISE); a.sx = -1; continue; }
    if (a.st == U_LEFT) {
      if (M.t < a.left_until) { steer(a, a.x + std::cos(a.hd + .6) * 800, a.y + std::sin(a.hd + .6) * 800, CRUISE - 2); a.sx = -1; continue; }
      a.st = U_REJOIN; logf("%s  sensor check complete  REJOINING slot %d", nm(i).c_str(), k);
    }
    if (!hears(i, G.leader)) { steer(a, a.x + std::cos(a.hd) * 1000, a.y + std::sin(a.hd) * 1000, CRUISE); a.sx = -1; continue; }
    V2 o = slot_offset(G.form, k, S);
    double px = L.x + L.ex - fx * o.x - fy * o.y, py = L.y + L.ey - fy * o.x + fx * o.y;
    a.sx = px; a.sy = py;
    double bx = a.x + a.ex, by = a.y + a.ey, along = (px - bx) * fx + (py - by) * fy;
    steer(a, px + fx * TUNE[1], py + fy * TUNE[1], L.spd + std::max(-6.0, std::min(9.0, along * TUNE[0])));
    double e = dist(a.x, a.y, px, py); if (a.st == U_ACTIVE) { M.slot_err_sum += e; ++M.slot_err_n; }
    if (a.st == U_REJOIN && e < 160) { a.st = U_ACTIVE; logf("%s  back in slot %d  %s formation", nm(i).c_str(), k, FORM[G.form]); }
  }
  return arrived;
}
// ground robots and boats before and after the search: drive to staging, later return home
void move_surface(bool outbound) {
  for (int i = M.nfw; i < M.n; ++i) {
    Uav& a = M.u[i]; if (!flying(a)) continue;
    int k = a.kind == K_GND ? i - M.nfw : i - M.nfw - M.nugv;
    V2 home = a.kind == K_GND ? FOB : HARBOR, stage = a.kind == K_GND ? GSTAGE : SSTAGE;
    V2 goal = outbound ? V2{stage.x + (k % 3) * 220, stage.y + (k / 3) * 220 * (a.kind == K_GND ? 1 : -1)} : V2{home.x + (k % 3) * 150, home.y};
    if (dist(a.x, a.y, goal.x, goal.y) > 60) steer(a, goal.x, goal.y, 9); else { a.spd = 0; a.vx = a.vy = 0; }
  }
}

// ------------------------------------------------------------------ search tasks (product CBBA, cross-domain)
void build_lanes() {
  M.lanes.clear();
  auto lane = [](double y, int grp, uint8_t dom) { Lane l; l.x0 = AREA_X0 + 250; l.x1 = AREA_X1 - 250; l.y0 = l.y1 = y; l.grp = grp; l.domain = dom; l.station = false; if ((int)M.lanes.size() % 2) std::swap(l.x0, l.x1); M.lanes.push_back(l); };
  auto station = [](double x, double y, int grp, uint8_t dom) { Lane l; l.x0 = l.x1 = x; l.y0 = l.y1 = y; l.grp = grp; l.domain = dom; l.station = true; M.lanes.push_back(l); };
  if (M.nfw == 1) { for (int k = 0; k < 3; ++k) { lane(8000 + k * 900, 0, T::kDomainAir); M.lanes.back().owner = 0; M.lanes.back().st = 1; } return; }
  int g0 = 0, g1 = M.do_split ? 1 : 0;
  for (double y = 7300; y <= 8800; y += 300) lane(y, g0, T::kDomainAir);                        // A: land lanes
  for (double y = 9300; y <= 10800; y += 300) lane(y, g0, T::kDomainAir);                       // A: water lanes
  for (double y = 3300; y <= 6800; y += 320) lane(y, g1, T::kDomainAir);                        // B: land lanes
  for (int k = 0; k < M.nugv; ++k) station(AREA_X0 + 800 + k * 950, 3700 + (k % 2) * 1600, g1, T::kDomainGround | T::kDomainAir);
  for (int k = 0; k < M.nusv; ++k) station(AREA_X0 + 1200 + k * 1400, 10300 - (k % 2) * 700, g0, T::kDomainSurface | T::kDomainAir);
}
void allocate_lanes() {
  if (M.nfw == 1) return;
  for (auto& l : M.lanes) {
    if (l.st == 3 || l.owner < 0) continue;
    Uav& o = M.u[l.owner];
    double last = -1e9; for (int j = 0; j < M.n; ++j) if (j != l.owner) last = std::max(last, M.u[j].heard[l.owner]);
    double age = M.t - last;
    if (age <= 3 && o.alive) { l.lease_until = M.t + LEASE_S; continue; }
    if (H::MayReallocatePeerWork(age, l.lease_until - M.t)) {
      char w[120]; std::snprintf(w, sizeof w, "declared %s (silent %.0f s, lease expired)  %s released", H::ToString(H::ClassifyPeer(age)), age, l.station ? "station" : "lane");
      bool seen = false; for (auto& p : M.pending_log) if (p.first == w && p.second == nm(l.owner)) seen = true;
      if (!seen) group_log(nm(l.owner), w);
      l.lost_from = l.owner; l.lost_at = last; l.owner = -1; l.st = 0;
      if (o.lane >= 0 && &M.lanes[o.lane] == &l) o.lane = -1;
    }
  }
  for (int gi = 0; gi < (M.do_split ? 2 : 1); ++gi) {
    std::vector<int> mem;
    for (int i : all_members(gi)) { Uav& a = M.u[i]; if (a.st == U_COMMLOST) continue; if (!a.ladder.permissions().may_accept_new_tasks) continue; mem.push_back(i); }
    std::vector<int> pool;
    for (int k = 0; k < (int)M.lanes.size(); ++k) { Lane& l = M.lanes[k]; if (l.grp != gi || l.st == 3 || l.st == 2) continue; if (l.owner >= 0 && std::find(mem.begin(), mem.end(), l.owner) == mem.end()) continue; pool.push_back(k); }
    std::vector<int> free_;
    for (int i : mem) if (M.u[i].lane < 0 || M.lanes[M.u[i].lane].st != 2) free_.push_back(i);
    if (pool.empty() || free_.empty()) continue;
    std::vector<T::Task> tv;
    for (int k : pool) {
      T::Task t; t.id = (T::TaskId)(k + 1); const Lane& l = M.lanes[k];
      t.location = PositionBelief(Eigen::Vector3d(l.x0, l.y0, 0), Eigen::Matrix3d::Identity() * 25.0);
      t.base_value = l.station ? 14 : 10; t.service_time_s = l.station ? 90 : std::fabs(l.x1 - l.x0) / CRUISE;
      t.req.domain_mask = l.domain; t.req.max_agent_position_sigma_m = 120.0; tv.push_back(t);
    }
    std::vector<T::CbbaAgent> ag; ag.reserve(free_.size());
    T::CbbaConfig cfg; cfg.max_bundle = 1;
    for (size_t m = 0; m < free_.size(); ++m) {
      Uav& a = M.u[free_[m]];
      T::AgentState st; st.id = (T::AgentId)(m + 1); st.profile = profile_of(a);
      st.position = PositionBelief(Eigen::Vector3d(a.x + a.ex, a.y + a.ey, 0), Eigen::Matrix3d::Identity() * (a.sigma * a.sigma));
      st.position.stamp.quality = ClockQuality::kMeshSynced;
      ag.emplace_back(st, &tv, free_.size(), &M.score, cfg);
    }
    for (int round = 0; round < 40; ++round) {
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
          char w[140]; std::snprintf(w, sizeof w, "took %s %d from %s  %.0f s after it went silent%s", l.station ? "station" : "lane", k + 1, nm(l.lost_from).c_str(), M.last_realloc_s,
                                     M.u[l.lost_from].kind != a.kind ? "  (cross-domain)" : "");
          group_log(nm(free_[m]), w); l.lost_at = -1;
        }
        if (a.lane >= 0 && a.lane != k && M.lanes[a.lane].owner == free_[m] && M.lanes[a.lane].st != 2) { M.lanes[a.lane].owner = -1; M.lanes[a.lane].st = 0; }
        l.owner = free_[m]; l.st = 1; l.lease_until = M.t + LEASE_S; a.lane = k; a.lane_leg = 0; a.dwell = 0; a.reserve = false;
      }
    }
  }
}
bool fly_search(int gi) {
  std::vector<int> relays;
  for (int i : all_members(gi)) {
    Uav& a = M.u[i]; a.sx = -1;
    if (a.st == U_COMMLOST) { if (M.t - a.lost_link_at < 45) steer(a, a.x + std::cos(a.hd) * 1000, a.y + std::sin(a.hd) * 1000, a.kind == K_AIR ? CRUISE : 5); else if (a.kind == K_AIR) orbit(a, RDV, 900); continue; }
    if (a.st == U_REJOIN) a.st = U_ACTIVE;
    if (a.lane < 0 && M.nfw == 1) for (int k = 0; k < (int)M.lanes.size(); ++k) if (M.lanes[k].owner == i && M.lanes[k].st == 1) { a.lane = k; a.lane_leg = 0; break; }
    if (a.lane < 0 || M.lanes[a.lane].owner != i) {
      a.lane = -1;
      if (a.kind == K_AIR) { a.reserve = true; relays.push_back(i); }        // no lane: relay ring over the group's sector
      else { a.spd = std::max(0.0, a.spd - 1.0 * DT); a.vx = std::cos(a.hd) * a.spd; a.vy = std::sin(a.hd) * a.spd; }
      continue;
    }
    a.reserve = false;
    Lane& l = M.lanes[a.lane]; double sp = a.kind == K_AIR ? CRUISE : 9;
    if (a.lane_leg == 0) { steer(a, l.x0, l.y0, sp + (a.kind == K_AIR ? 4 : 0)); if (dist(a.x + a.ex, a.y + a.ey, l.x0, l.y0) < (a.kind == K_AIR ? 200 : 40)) { a.lane_leg = 1; l.st = 2; } }
    else if (l.station) { if (a.kind == K_AIR) orbit(a, V2{l.x0, l.y0}, 300); else { a.spd = 0; a.vx = a.vy = 0; }
      a.dwell += DT; if (a.dwell >= 90) { l.st = 3; group_log(nm(i), "station held"); a.lane = -1; } }
    else { steer(a, l.x1, l.y1, sp); if (dist(a.x + a.ex, a.y + a.ey, l.x1, l.y1) < 200) { l.st = 3; group_log(nm(i), "lane complete"); a.lane = -1; } }
  }
  if (!relays.empty()) ring_targets(relays, V2{(AREA_X0 + AREA_X1) / 2, gi == 0 ? 9000.0 : 5000.0});
  for (auto& l : M.lanes) if (l.grp == gi && l.st != 3) return false;
  return true;
}

// ------------------------------------------------------------------ separation (product), aircraft only
void separation() {
  for (int i = 0; i < M.nfw; ++i) {
    Uav& a = M.u[i]; if (!flying(a)) continue;
    T::SepPeer self; self.id = i + 1; self.pos = geo(a.x + a.ex, a.y + a.ey, a.alt);
    std::vector<T::SepPeer> peers;
    for (int j = 0; j < M.nfw; ++j) {
      if (j == i || !flying(M.u[j]) || !hears(i, j)) continue;
      if (dist(a.x, a.y, M.u[j].x, M.u[j].y) > 1500) continue;                // far peers cannot conflict within the decision horizon
      T::SepPeer p; p.id = j + 1; p.pos = geo(M.u[j].x + M.u[j].ex, M.u[j].y + M.u[j].ey, M.u[j].alt); peers.push_back(p);
    }
    T::SeparationResult r = T::CheckSeparation(self, peers, 150.0);
    if (r.layer != a.layer) {
      if (r.layer > a.layer) { ++M.sep_yields; char w[80]; std::snprintf(w, sizeof w, "separation yield  climbing to layer %d (+%d m)", r.layer, r.layer * 40); group_log(nm(i), w); }
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
    case E_LEAVE: if (arg >= 0 && arg < M.nfw && M.u[arg].st == U_ACTIVE && M.g[M.u[arg].grp].leader != arg && M.phase < P_SEARCH) { M.u[arg].st = U_LEFT; M.u[arg].left_until = M.t + 40; logf("EVENT  %s leaves formation  sensor check, 40 s", nm(arg).c_str()); } break;
    case E_FORM: { int gi = (arg >= 0 && arg < M.nfw && M.split_done && M.phase < P_RENDEZVOUS) ? M.u[arg].grp : 0; Form f = M.g[gi].form;
                   if (f == F_SEARCH || f == F_RING) break;
                   Form nf = f == F_WEDGE ? F_V : f == F_V ? F_LINE : f == F_LINE ? F_COLUMN : F_WEDGE; set_form(gi, nf, "(commanded)"); } break;
  }
}
void run_script() { for (auto& e : M.script) if (!e.done && (int)M.phase == e.phase && M.t - M.phase_t0 >= e.after) { e.done = true; apply_event(e.kind, e.arg); } }
void request(int id, const char* text) { if (M.pending == id) return; M.pending = id; M.decision = text; logf("AWAITING OPERATOR  %s", text); }

// ------------------------------------------------------------------ mission phases (demonstration script)
void mission() {
  switch (M.phase) {
    case P_LAUNCH: {
      for (int i = 0; i < M.n; ++i) if (M.u[i].st == U_READY) {
        Uav& a = M.u[i];
        if (a.kind != K_AIR) { a.st = U_ACTIVE; group_log(nm(i), a.kind == K_GND ? "ground robot online at FOB" : "boat online at harbour"); continue; }
        if (M.t - M.last_launch >= 1.2) { a.st = U_ACTIVE; a.spd = 18; a.target_alt = 150; M.last_launch = M.t; group_log(nm(i), "launched"); }
        break;
      }
      if (M.nfw == 1) { if (flying(M.u[0])) { set_phase(P_TRANSIT); M.g[0].form = F_COLUMN; } break; }
      ring_targets(air_members(0), ASSEMBLE);
      { bool ready = true; for (int i = 0; i < M.nfw; ++i) if (M.u[i].st == U_READY) ready = false;
        if (ready) set_phase(P_ASSEMBLY); }
      break;
    }
    case P_ASSEMBLY: {
      auto mem = air_members(0); ring_targets(mem, ASSEMBLE);
      double err = 0; for (int i : mem) err += dist(M.u[i].x, M.u[i].y, M.u[i].sx, M.u[i].sy); err /= std::max<size_t>(1, mem.size());
      if ((err < 600 && M.t - M.phase_t0 > 20) || M.t - M.phase_t0 > 180) { set_phase(P_FORMATION); set_form(0, F_WEDGE, "(swarm assembled)"); }
      break;
    }
    case P_FORMATION: {
      fly_formation(0);
      double err = 0; int c = 0; for (int i : air_members(0)) if (M.u[i].sx >= 0) { err += dist(M.u[i].x, M.u[i].y, M.u[i].sx, M.u[i].sy); ++c; }
      if ((c && err / c < 300 && M.t - M.phase_t0 > 15) || M.t - M.phase_t0 > 110) set_phase(P_TRANSIT);
      break;
    }
    case P_TRANSIT: {
      Group& G = M.g[0];
      move_surface(true);
      if (G.wp == 1 && G.form != F_COLUMN && M.nfw > 1) set_form(0, F_COLUMN, "(narrow corridor W1-W2)");
      if (G.wp == 2 && G.form == F_COLUMN) set_form(0, F_V, "(corridor cleared)");
      if (fly_formation(0)) {
        if (M.do_search && M.do_split) {
          G.hold = true; G.hold_at = W3;
          char msg[160]; std::snprintf(msg, sizeof msg, "Commence search: split into Group A (U01-U%02d, boats) and Group B (U%02d-U%02d, ground robots)?", M.nfw / 2, M.nfw / 2 + 1, M.nfw);
          request(1, msg);
        } else if (M.do_search) { build_lanes(); set_form(0, F_SEARCH, "(search pattern)"); set_phase(P_SEARCH); }
        else { G.hold = true; G.hold_at = W3; request(2, "Route complete. Return to base?"); }
      }
      break;
    }
    case P_SPLIT: {
      move_surface(true);
      bool a = fly_formation(0), b = fly_formation(1);
      if (a && b) { build_lanes(); set_form(0, F_SEARCH, "(search pattern)"); set_form(1, F_SEARCH, "(search pattern)"); set_phase(P_SEARCH); M.next_alloc = 0; }
      break;
    }
    case P_SEARCH: {
      if (M.t >= M.next_alloc) { allocate_lanes(); M.next_alloc = M.t + 2.0; }
      bool da = fly_search(0), db = M.do_split ? fly_search(1) : true;
      if (da && db) {
        logf("SEARCH COMPLETE  every lane flown, every station held");
        if (M.nfw == 1) { M.g[0].path = {W4, BASE}; M.g[0].wp = 0; set_form(0, F_COLUMN, "(return)"); set_phase(P_RTB); }
        else { set_phase(P_RENDEZVOUS); for (int gi = 0; gi < 2; ++gi) M.g[gi].form = F_RING; }
      }
      break;
    }
    case P_RENDEZVOUS: {
      move_surface(false);
      std::vector<int> mem; for (int i = 0; i < M.nfw; ++i) if (flying(M.u[i]) && M.u[i].st != U_COMMLOST) mem.push_back(i);
      ring_targets(mem, RDV);
      for (int i = 0; i < M.nfw; ++i) if (M.u[i].st == U_COMMLOST) orbit(M.u[i], RDV, 1600);
      double err = 0; for (int i : mem) err += dist(M.u[i].x, M.u[i].y, M.u[i].sx, M.u[i].sy); err /= std::max<size_t>(1, mem.size());
      if ((err < 550 && M.t - M.phase_t0 > 25) || M.t - M.phase_t0 > 180) {
        for (int i = 0; i < M.nfw; ++i) M.u[i].grp = 0;
        M.g[1].active = false; M.g[0].hold = false; M.g[0].path = {V2{RDV.x - 2500, RDV.y - 900}}; M.g[0].wp = 0; M.g[0].leader = -1;
        set_form(0, F_WEDGE, "(groups merged)"); logf("RENDEZVOUS  Group A and Group B rejoined  %zu aircraft", mem.size());
        set_phase(P_REFORM);
      }
      break;
    }
    case P_REFORM: {
      move_surface(false);
      bool at = fly_formation(0);
      if (at || M.t - M.phase_t0 > 80) { M.g[0].hold = true; M.g[0].hold_at = M.g[0].path.back(); request(2, "Search complete. Return to base?"); }
      break;
    }
    case P_RTB: {
      move_surface(false);
      Group& G = M.g[0];
      if (G.wp >= 1 && G.form != F_COLUMN && M.nfw > 1) set_form(0, F_COLUMN, "(landing sequence)");
      if (!M.landing) { if (fly_formation(0)) { M.landing = true; logf("LANDING SEQUENCE  three on approach, one landing every 3 s"); } }
      if (M.landing) {
        std::vector<std::pair<double, int>> order;
        for (int i = 0; i < M.nfw; ++i) if (flying(M.u[i])) order.push_back({dist(M.u[i].x, M.u[i].y, BASE.x, BASE.y), i});
        std::sort(order.begin(), order.end());
        for (size_t r = 0; r < order.size(); ++r) {
          int i = order[r].second; Uav& a = M.u[i]; a.sx = -1;
          if (r < 3) { steer(a, BASE.x, BASE.y, 22); a.target_alt = 0;
            if (dist(a.x, a.y, BASE.x, BASE.y) < 300 && M.t - M.last_land >= 3.0) { a.st = U_LANDED; a.alt = 0; a.spd = 0; M.last_land = M.t; group_log(nm(i), "landed"); } }
          else orbit(a, BASE, 1000 + 70 * (i % 7));
        }
      }
      for (int i = M.nfw; i < M.n; ++i) { Uav& a = M.u[i]; if (flying(a) && a.spd < .1 && dist(a.x, a.y, a.kind == K_GND ? FOB.x : HARBOR.x, a.kind == K_GND ? FOB.y : HARBOR.y) < 500) { a.st = U_LANDED; group_log(nm(i), a.kind == K_GND ? "back at FOB" : "back in harbour"); } }
      bool any = false; for (int i = 0; i < M.n; ++i) if (flying(M.u[i]) && (M.u[i].kind == K_AIR || M.u[i].st != U_COMMLOST)) any = true;
      if (!any || (M.landing && M.t - M.phase_t0 > 2400)) { set_phase(P_COMPLETE); M.complete_at = M.t; logf("MISSION COMPLETE"); }
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
    for (int i = 0; i < M.nfw; ++i) M.u[i].grp = i < M.nfw / 2 ? 0 : 1;
    M.g[0].hold = false; M.g[1].active = true; M.g[1].hold = false;
    M.g[0].path = {V2{AREA_X0 - 700, AREA_YM + 2000}}; M.g[0].wp = 0; M.g[0].leader = -1;
    M.g[1].path = {V2{AREA_X0 - 700, AREA_YM - 2000}}; M.g[1].wp = 0; M.g[1].leader = -1;
    M.g[0].form = F_LINE; M.g[1].form = F_LINE; M.split_done = true;
    logf("SPLIT  Group A: %d aircraft + %d boats, north (land and water)  Group B: %d aircraft + %d ground robots, south",
         (int)air_members(0).size(), M.nusv, (int)air_members(1).size(), M.nugv);
    set_phase(P_SPLIT);
  } else if (id == 2) {
    M.g[0].hold = false; M.g[0].path = {W4, BASE}; M.g[0].wp = 0; M.g[0].leader = -1;
    set_phase(P_RTB);
  }
}

void step() {
  run_script(); radio();
  for (int i = 0; i < M.n; ++i) if (flying(M.u[i])) { nav(M.u[i]); health(M.u[i]); }
  if (M.t >= M.next_sep) { separation(); M.next_sep = M.t + 1.0; }
  mission(); flush_log(); M.t += DT;
}

uint64_t fnv(uint64_t h, const void* p, size_t n) { const uint8_t* b = (const uint8_t*)p; for (size_t i = 0; i < n; ++i) { h ^= b[i]; h *= 1099511628211ull; } return h; }
constexpr int UF = 26;
double snap_buf[MAXV * UF + MAXV * MAXV + 128 * 8 + 8];
double meta_buf[40];
double geom_buf[64];
}  // namespace

extern "C" {
__attribute__((export_name("m_init")))    void m_init(int scenario, double seed) { reset(scenario, (uint64_t)seed); }
__attribute__((export_name("m_step")))    void m_step(int k) { for (int i = 0; i < k; ++i) step(); }
__attribute__((export_name("m_event")))   void m_event(int kind, int arg) { if (kind == 20) confirm(arg); else apply_event(kind, arg); }
__attribute__((export_name("m_tune")))    void m_tune(int i, double v) { if (i >= 0 && i < 6) TUNE[i] = v; }
__attribute__((export_name("m_n")))       int m_n() { return M.n; }
__attribute__((export_name("m_nlanes")))  int m_nlanes() { return (int)M.lanes.size(); }
__attribute__((export_name("m_snapshot"))) double* m_snapshot() {
  int o = 0;
  for (int i = 0; i < M.n; ++i) {
    const Uav& a = M.u[i]; int links = 0, alive = 0;
    for (int j = 0; j < M.n; ++j) if (j != i && flying(M.u[j])) { ++alive; links += M.t - a.heard[j] <= 3; }
    double v[UF] = {a.x, a.y, a.alt, a.hd, a.spd, (double)a.grp, M.g[a.grp].leader == i ? 1.0 : 0.0, (double)a.st, a.sigma, (double)a.src,
                    (double)a.rung, (double)a.regime, alive ? (double)links / alive : 1.0, a.tx, a.ty, a.sx, a.sy, a.vx, a.vy, (double)a.layer,
                    (double)a.lane, a.x + a.ex, a.y + a.ey, (double)a.slot, (double)a.kind, a.reserve ? 1.0 : 0.0};
    std::memcpy(snap_buf + o, v, sizeof v); o += UF;
  }
  for (int i = 0; i < M.n * M.n; ++i) snap_buf[o++] = M.link[(i / M.n) * MAXV + (i % M.n)];
  for (auto& l : M.lanes) { snap_buf[o++] = l.x0; snap_buf[o++] = l.y0; snap_buf[o++] = l.x1; snap_buf[o++] = l.y1; snap_buf[o++] = l.grp; snap_buf[o++] = l.st; snap_buf[o++] = l.owner; snap_buf[o++] = l.station ? 1 : 0; }
  return snap_buf;
}
__attribute__((export_name("m_meta"))) double* m_meta() {
  int act = 0, rej = 0, cl = 0, lost = 0, landed = 0, left = 0, na = 0, nb = 0, fw = 0, gnd = 0, sea = 0, relay = 0;
  for (int i = 0; i < M.n; ++i) { const Uav& a = M.u[i];
    act += a.st == U_ACTIVE; rej += a.st == U_REJOIN; cl += a.st == U_COMMLOST; lost += a.st == U_LOST; landed += a.st == U_LANDED; left += a.st == U_LEFT;
    if (flying(a)) { if (a.kind == K_AIR) { ++fw; if (a.grp == 0) ++na; else ++nb; relay += a.reserve; } else if (a.kind == K_GND) ++gnd; else ++sea; } }
  double m[40] = {M.t, (double)M.phase, (double)M.g[0].form, (double)M.g[1].form, (double)na, (double)nb, (double)M.g[0].leader, (double)M.g[1].leader,
                  (double)act, (double)rej, (double)cl, (double)lost, (double)landed, (double)left, M.gps_zone ? 1.0 : 0.0, M.gps_global ? 1.0 : 0.0,
                  M.radio_degraded ? 1.0 : 0.0, (double)M.pending, M.complete_at, (double)M.n, M.split_done ? 1.0 : 0.0, M.g[1].active ? 1.0 : 0.0,
                  M.last_realloc_s, (double)M.scenario, spacing_scale(0), spacing_scale(1), M.slot_err_n ? M.slot_err_sum / M.slot_err_n : 0, (double)M.sep_yields,
                  (double)M.nfw, (double)M.nugv, (double)M.nusv, (double)fw, (double)gnd, (double)sea, (double)relay, 0, 0, 0, 0, 0};
  std::memcpy(meta_buf, m, sizeof m); return meta_buf;
}
__attribute__((export_name("m_geom"))) double* m_geom() {
  double gm[] = {BASE.x, BASE.y, ASSEMBLE.x, ASSEMBLE.y, W1.x, W1.y, W2.x, W2.y, W3.x, W3.y, RDV.x, RDV.y, W4.x, W4.y,
                 AREA_X0, AREA_Y0, AREA_X1, AREA_Y1, AREA_YM, GPS_X0, GPS_Y0, GPS_X1, GPS_Y1,
                 WATER_X0, WATER_Y0, FOB.x, FOB.y, HARBOR.x, HARBOR.y};
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
