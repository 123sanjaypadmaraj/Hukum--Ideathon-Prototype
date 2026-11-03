// Skills shown in the Agents UI. Mirrors agents/skills/<name>/SKILL.md.
import { h, colorOf, iconSvg } from './util.js';

export const SKILLS = [
  { id: 'supervisor', name: 'supervisor', file: 'nodes/supervisor.py', when: 'Start of every run and after each agent finishes.', how: 'Builds the route from the mode or goal and hands control to the next agent. Environment is reached only through the solar loop.', out: 'route, next' },
  { id: 'mapping', name: 'mapping', file: 'nodes/mapping.py', when: 'First, or when the building model is missing or stale.', how: 'Reads the scan export, reconciles rooms and equipment tags, reports gaps and confidence.', out: 'building model, gaps' },
  { id: 'solar_planner', name: 'solar-planner', file: 'nodes/solar_planner.py', when: 'After mapping, or when the reviewer sends the plan back.', how: 'Sizes panels and storage per roof, estimates yield, revises on feedback.', out: 'solar plan, yield estimate' },
  { id: 'environment', name: 'environment', file: 'nodes/environment.py', when: 'As the reviewer in the solar loop.', how: 'Checks shading, tilt, heat, dust and carbon impact; approves or returns the plan.', out: 'review verdict, carbon savings' },
  { id: 'solar_health', name: 'solar-health', file: 'nodes/solar_health.py', when: 'Monitoring installed panels and inverters.', how: 'Compares measured and expected generation, flags soiling, shading or inverter faults.', out: 'health score, flagged arrays' },
  { id: 'fault_maintenance', name: 'fault-maintenance', file: 'nodes/fault_maintenance.py', when: 'When readings drift from nameplate values.', how: 'Compares measured loads with nameplate data and ranks faults by cost and risk.', out: 'fault list, maintenance schedule' },
  { id: 'bill_auditor', name: 'bill-auditor', file: 'nodes/bill_auditor.py', when: 'A bill arrives or a tariff changes.', how: 'Recomputes the bill from meter data and lists overcharges.', out: 'audit findings, recoverable amount' },
  { id: 'negotiator', name: 'negotiator', file: 'nodes/negotiator.py', when: 'After the optimiser has a schedule.', how: 'Takes midday surplus (10:00-15:00 export) and prices a trade or credit between campuses.', out: 'surplus kWh, trade terms' },
  { id: 'optimiser', name: 'optimiser', file: 'nodes/optimiser.py', when: 'Before control acts.', how: 'Solves 96 x 15-minute slots by dynamic programming over battery charge; compares with do-nothing.', out: 'schedule, savings vs baseline' },
  { id: 'control', name: 'control', file: 'nodes/control.py', when: 'Last. The only agent that changes anything.', how: 'Modes: shadow (log only), approve (wait for a yes), automate. Never touches the data centre, health centre or CCTV room.', out: 'actions with status' },
  { id: 'reporter', name: 'reporter', file: 'nodes/reporter.py', when: 'End of every run.', how: 'Tolerates missing agent outputs; writes headline, sections and KPIs.', out: 'headline, sections, kpis' },
];

export function renderSkills() {
  return h('div', { class: 'ag-sections' }, ...SKILLS.map((s) =>
    h('section', { class: 'ag-card ag-skill', style: { borderLeftColor: colorOf(s.id) } },
      h('h3', {}, h('span', { class: 'ag-tabico', style: { color: colorOf(s.id) } }, iconSvg(s.id, 13)), ' ', s.name),
      h('p', {}, h('b', {}, 'When: '), s.when),
      h('p', {}, h('b', {}, 'How: '), s.how),
      h('p', {}, h('b', {}, 'Outputs: '), s.out),
      h('p', { class: 'mono' }, 'agents/skills/' + s.name + '/SKILL.md'))));
}
