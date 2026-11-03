"""HUKUM model-campus simulation (no AC). 15-min LP, perfect day-ahead foresight.
Run: python3 hukum_sim.py  -> prints results, writes results.json and profiles.csv
"""
import json, numpy as np
from scipy.optimize import linprog
from scipy.sparse import lil_matrix

T, dt = 96, 0.25
h = np.arange(T) * dt                      # hour of day at start of each slot
def win(a, b):                             # slots with a <= hour < b (b may wrap past 24)
    return ((h >= a) & (h < b)) if b <= 24 else ((h >= a) | (h < b - 24))

# ---------------- tariff (ToD +-20%) ----------------
price = np.full(T, 8.0); price[win(9, 17)] = 6.4; price[win(18, 22)] = 9.6
EXPORT = 3.0
DEMAND = 400 / 30 / 0.95                   # Rs per kW of daily max import (Rs400/kVA-month, pf 0.95)

# ---------------- solar ----------------
KWP = 400
def solar(cloud):
    s = np.clip(np.sin(np.pi * (h + dt / 2 - 6.25) / 12.5), 0, None) ** 1.3
    return KWP * 0.78 * s * cloud
SUNNY, CLOUDY = 1.0, 0.40

# ---------------- fixed loads ----------------
rng = np.random.default_rng(7)
ROOMS, ROOM_KW = 60, 0.9                    # 8 fans x 60 W + 8 LED tubes x 20 W + projector 250 W
teach = [9, 10, 11, 12, 14, 15, 16]         # 1-h periods; lunch 13-14
occ = rng.random((ROOMS, len(teach))) < 0.75
TAIL = 10 / 60                              # auto-off after 10 min empty
def classrooms(auto_off):
    p = np.zeros(T)
    if not auto_off:
        p[win(8.75, 17.75)] = ROOMS * ROOM_KW
        return p
    for r in range(ROOMS):
        on = np.zeros(T, bool)
        for k, start in enumerate(teach):
            if occ[r, k]:
                on |= win(start - 0.25, start + 1)          # lights on 15 min before class
                nxt = k + 1 < len(teach) and occ[r, k + 1] and teach[k + 1] == start + 1
                if not nxt:                                 # 10-min tail before switch-off
                    on |= win(start + 1, start + 1 + TAIL + 1e-9)
        p += on * ROOM_KW
    return p

LABS, PCS = 10, 60
PC_ACTIVE, PC_IDLE, PC_SLEEP = 0.100, 0.060, 0.003     # kW per PC incl. monitor
lab_sessions = [(9, 12), (14, 17)]
lab_use = rng.random((LABS, 2)) < 0.60                   # 60% of lab sessions booked
def labs(sleep_idle):
    p = np.zeros(T)
    for l in range(LABS):
        on_day = win(8.75, 17.75)
        busy = np.zeros(T, bool)
        for k, (a, b) in enumerate(lab_sessions):
            if lab_use[l, k]: busy |= win(a, b)
        idle_kw = PC_SLEEP if sleep_idle else PC_IDLE
        p += PCS * np.where(busy, PC_ACTIVE, np.where(on_day, idle_kw, PC_SLEEP))
    return p

def base():
    p = np.full(T, 25.0)                                 # server room, security, misc
    p[win(8.5, 17.5)] += 70                              # admin, library, workshops, canteen
    p[win(18, 23)] += 60                                 # hostel evening load
    p[win(18.5, 30)] += 15                               # street & campus lighting (to 6 AM)
    return p

# ---------------- flexible loads ----------------
PUMP_KW, PUMP_KWH = 30, 240                              # 2 x 15 kW, 8 h/day
EV_N, EV_KW, EV_KWH = 25, 7.4, 8                         # staff cars, present 9-17
BUS_N, BUS_KW, BUS_KWH = 2, 30, 100                      # e-buses; at depot 9:30-16:00 and 17:30-07:00
UPS_KWH, UPS_KW, UPS_RESERVE = 80, 12, 0.5               # 10 lab UPS, lead-acid, keep 50% for outages
UPS_WEAR = 35.0                                          # Rs per kWh cycled (VRLA ~500 cycles @50% DoD)
BAT_WEAR, BAT_EFF = 1.5, 0.95                            # one-way efficiency

def baseline_flex():
    pump = np.zeros(T); pump[win(5.5, 9.5)] = PUMP_KW; pump[win(18, 22)] = PUMP_KW
    ev = np.zeros(T); n = EV_N * EV_KWH / (EV_KW * EV_N) / dt
    ev[np.where(win(9, 17))[0][:int(np.ceil(n))]] = EV_N * EV_KW   # charge on arrival
    ev *= EV_N * EV_KWH / (ev.sum() * dt)
    bus = np.zeros(T); bus[win(17.5, 17.5 + BUS_KWH / BUS_KW)] = BUS_N * BUS_KW; bus *= BUS_N * BUS_KWH / (bus.sum() * dt)          # charge on evening return
    return pump, ev, bus

STUCK = 0.20                                             # share of flexible load that stays at its usual time
def solve(cloud, battery_kwh, hukum=False, auto=None, sleep=None, flex=None, ups=None):
    auto, sleep, flex, ups = [hukum if v is None else v for v in (auto, sleep, flex, ups)]
    pv = solar(cloud)
    fixed = classrooms(auto) + labs(sleep) + base()
    names = ['imp', 'exp', 'bc', 'bd', 'soc', 'pump', 'ev', 'bus', 'uc', 'ud', 'us']
    idx = {n: np.arange(T) + i * T for i, n in enumerate(names)}
    N = len(names) * T + 1; PEAK = N - 1
    c = np.zeros(N)
    c[idx['imp']] = price * dt; c[idx['exp']] = -EXPORT * dt
    c[idx['bc']] = BAT_WEAR * dt / 2; c[idx['bd']] = BAT_WEAR * dt / 2
    c[idx['uc']] = UPS_WEAR * dt / 2; c[idx['ud']] = UPS_WEAR * dt / 2
    c[PEAK] = DEMAND
    bounds = [(0, None)] * N
    bp = battery_kwh / 2                                  # 0.5C battery
    for t in range(T):
        bounds[idx['bc'][t]] = bounds[idx['bd'][t]] = (0, bp)
        bounds[idx['soc'][t]] = (0.1 * battery_kwh, battery_kwh)
        ups_on = ups
        bounds[idx['uc'][t]] = bounds[idx['ud'][t]] = (0, UPS_KW if ups_on else 0)
        bounds[idx['us'][t]] = (UPS_RESERVE * UPS_KWH, UPS_KWH)
    bpump, bev, bbus = baseline_flex()
    if flex:
        ev_ok, bus_ok = win(9, 17), (win(9.5, 16) | win(17.5, 31))
        for t in range(T):
            bounds[idx['pump'][t]] = (STUCK * bpump[t], PUMP_KW)
            bounds[idx['ev'][t]] = (STUCK * bev[t], EV_N * EV_KW if ev_ok[t] else STUCK * bev[t])
            bounds[idx['bus'][t]] = (STUCK * bbus[t], BUS_N * BUS_KW if bus_ok[t] else STUCK * bbus[t])
    else:
        for t in range(T):
            bounds[idx['pump'][t]] = (bpump[t],) * 2
            bounds[idx['ev'][t]] = (bev[t],) * 2
            bounds[idx['bus'][t]] = (bbus[t],) * 2
    Aeq, beq, Aub, bub = [], [], [], []
    def row(): return np.zeros(N)
    for t in range(T):                                     # power balance
        r = row(); r[idx['imp'][t]] = 1; r[idx['exp'][t]] = -1
        r[idx['bc'][t]] = -1; r[idx['bd'][t]] = 1; r[idx['uc'][t]] = -1; r[idx['ud'][t]] = 1
        r[idx['pump'][t]] = r[idx['ev'][t]] = r[idx['bus'][t]] = -1
        Aeq.append(r); beq.append(fixed[t] - pv[t])
        for s, cc, dd, eff in (('soc', 'bc', 'bd', BAT_EFF), ('us', 'uc', 'ud', 0.85)):
            r = row(); r[idx[s][t]] = 1; r[idx[s][t - 1]] -= 1      # cyclic day (t-1 wraps)
            r[idx[cc][t]] = -eff * dt; r[idx[dd][t]] = dt / eff
            Aeq.append(r); beq.append(0)
        r = row(); r[idx['imp'][t]] = 1; r[PEAK] = -1; Aub.append(r); bub.append(0)
    for name, need in (('pump', PUMP_KWH), ('ev', EV_N * EV_KWH), ('bus', BUS_N * BUS_KWH)):
        r = row(); r[idx[name]] = dt; Aeq.append(r); beq.append(need)
    if battery_kwh == 0:
        for t in range(T): bounds[idx['soc'][t]] = (0, 0)
    res = linprog(c, A_ub=np.array(Aub), b_ub=bub, A_eq=np.array(Aeq), b_eq=beq,
                  bounds=bounds, method='highs')
    assert res.status == 0, res.message
    x = res.x; g = lambda n: x[idx[n]]
    load = fixed + g('pump') + g('ev') + g('bus')
    evening = win(18, 22)
    out = dict(cost=res.fun - DEMAND * x[PEAK], total_with_demand=res.fun, peak=x[PEAK], evening_peak=g('imp')[evening].max(),
               energy_cost=(price * g('imp') * dt).sum(), export_kwh=g('exp').sum() * dt,
               import_kwh=g('imp').sum() * dt, solar_kwh=pv.sum() * dt,
               self_use=1 - g('exp').sum() * dt / (pv.sum() * dt),
               ups_cycled=g('ud').sum() * dt, load_kwh=load.sum() * dt,
               classroom_kwh=classrooms(auto).sum() * dt, lab_kwh=labs(sleep).sum() * dt)
    prof = dict(solar=pv, load=load, imp=g('imp'), fixed=fixed, pump=g('pump'), ev=g('ev'), bus=g('bus'))
    return out, prof

if __name__ == '__main__':
    BAT = 200
    R, P = {}, {}
    for day, cl in (('sunny', SUNNY), ('cloudy', CLOUDY)):
        for sc, (b, hk) in {'none': (0, False), 'battery': (BAT, False), 'hukum': (BAT, True),
                            'hukum_nobatt': (0, True)}.items():
            R[f'{day}_{sc}'], P[f'{day}_{sc}'] = solve(cl, b, hk)
    # smallest battery for HUKUM to match battery-only cost (sunny)
    target = R['sunny_battery']['cost']; match = None
    for b in range(0, BAT + 1, 5):
        if solve(SUNNY, b, True)[0]['cost'] <= target + 1e-6: match = b; break
    R['match_battery_kwh'] = match
    # lever breakdown, sunny day, no battery: add one lever at a time
    steps = [('none', {}), ('auto_off', dict(auto=True)), ('lab_sleep', dict(auto=True, sleep=True)),
             ('shift', dict(auto=True, sleep=True, flex=True)), ('ups', dict(auto=True, sleep=True, flex=True, ups=True))]
    prev = None; R['levers'] = {}
    for name, kw in steps:
        cst = solve(SUNNY, 0, **kw)[0]['cost']
        if prev is not None: R['levers'][name] = prev - cst
        prev = cst
    R['levers']['battery_200'] = R['sunny_hukum_nobatt']['cost'] - R['sunny_hukum']['cost']
    print('levers', {k: round(v) for k, v in R['levers'].items()})
    for k, v in R.items():
        if isinstance(v, dict) and 'cost' in v:
            print(f"{k:22s} cost {v['cost']:8.0f}  peak {v['peak']:5.0f}  eve {v['evening_peak']:5.0f}  "
                  f"imp {v['import_kwh']:6.0f} exp {v['export_kwh']:5.0f} self {v['self_use']:.0%} ups {v['ups_cycled']:.1f} "
                  f"cls {v['classroom_kwh']:.0f} lab {v['lab_kwh']:.0f} load {v['load_kwh']:.0f}")
    print('match battery', match)
    json.dump(R, open('results.json', 'w'), indent=1, default=float)
    import csv
    with open('profiles.csv', 'w', newline='') as f:
        w = csv.writer(f); keys = ['sunny_none', 'sunny_hukum']
        w.writerow(['hour', 'solar', 'load_none', 'load_hukum', 'imp_none', 'imp_hukum', 'base', 'classrooms', 'labs', 'pump', 'ev', 'bus'])
        for t in range(T):
            w.writerow([h[t], P['sunny_none']['solar'][t], P['sunny_none']['load'][t], P['sunny_hukum']['load'][t],
                        P['sunny_none']['imp'][t], P['sunny_hukum']['imp'][t], base()[t], classrooms(False)[t],
                        labs(False)[t], P['sunny_none']['pump'][t], P['sunny_none']['ev'][t], P['sunny_none']['bus'][t]])
