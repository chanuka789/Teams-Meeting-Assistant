// RICS APC Quantity surveying and construction pathway competencies, from the RICS pathway guide
// (December 2025, version 1.1). Seeded once; admins can edit the list in the app.
// level = the level required on the pathway (optional competencies: two chosen to Level 2).

export const SEED_COMPETENCIES = [
  // Mandatory
  { name: 'Ethics, Rules of Conduct and professionalism', category: 'mandatory', level: 3 },
  { name: 'Client care', category: 'mandatory', level: 2 },
  { name: 'Communication and negotiation', category: 'mandatory', level: 2 },
  { name: 'Health and safety', category: 'mandatory', level: 2 },
  { name: 'Accounting principles and procedures', category: 'mandatory', level: 1 },
  { name: 'Business planning', category: 'mandatory', level: 1 },
  { name: 'Conflict avoidance, management and dispute resolution procedures', category: 'mandatory', level: 1 },
  { name: 'Data management', category: 'mandatory', level: 1 },
  { name: 'Diversity, inclusion and teamworking', category: 'mandatory', level: 1 },
  { name: 'Inclusive environments', category: 'mandatory', level: 1 },
  { name: 'Sustainability', category: 'mandatory', level: 1 },
  // Core (Commercial management OR Design economics and cost planning to Level 3)
  { name: 'Commercial management (of construction works)', category: 'core', level: 3 },
  { name: 'Design economics and cost planning', category: 'core', level: 3 },
  { name: 'Construction technology and environmental services', category: 'core', level: 3 },
  { name: 'Contract practice', category: 'core', level: 3 },
  { name: 'Procurement and tendering', category: 'core', level: 3 },
  { name: 'Project finance (control and reporting)', category: 'core', level: 3 },
  { name: 'Quantification and costing (of construction works)', category: 'core', level: 3 },
  // Optional (two to Level 2)
  { name: 'Capital allowances', category: 'optional', level: 2 },
  { name: 'Contract administration', category: 'optional', level: 2 },
  { name: 'Corporate recovery and insolvency', category: 'optional', level: 2 },
  { name: 'Due diligence', category: 'optional', level: 2 },
  { name: 'Insurance', category: 'optional', level: 2 },
  { name: 'Programming and planning', category: 'optional', level: 2 },
  { name: 'Project feasibility analysis', category: 'optional', level: 2 },
  { name: 'Risk management', category: 'optional', level: 2 },
  // Documents that cover several competencies (NRM, RICS standards, pathway guide…)
  { name: 'General RICS guidance', category: 'general', level: null },
];
