/**
 * rules.ts — Rule metadata for the admin panel.
 *
 * Returns rule definitions (id, name, severity, description, required reference file)
 * without importing the full rules evaluation engine.
 *
 * Keep in sync with rules.ts in workers/report/src/ when rules are added/removed.
 */

export interface RuleInfo {
  id: string;
  displayName: string;
  severity: 'marquee' | 'featured' | 'note';
  description: string;
  defaultEnabled: boolean;
  requiresReferenceFile: string | null;  // filename in ReferenceLists/ or null
}

export const RULES: RuleInfo[] = [
  {
    id: 'gc30_mingo',
    displayName: 'GC30 — Mingo',
    severity: 'marquee',
    description: 'Found GC30 (Mingo), the oldest active cache in the world.',
    defaultEnabled: true,
    requiresReferenceFile: null,
  },
  {
    id: 'rare_cache_type',
    displayName: 'Rare Cache Type',
    severity: 'marquee',
    description: 'Found a rare cache type: Letterbox Hybrid, Wherigo, or GPS Adventures Maze.',
    defaultEnabled: true,
    requiresReferenceFile: null,
  },
  {
    id: 'mega_giga_event',
    displayName: 'Mega/Giga Event',
    severity: 'marquee',
    description: 'Attended a Mega or Giga Event cache.',
    defaultEnabled: true,
    requiresReferenceFile: null,
  },
  {
    id: 'milestone_find',
    displayName: 'Milestone Find',
    severity: 'marquee',
    description: 'A find lands on a significant milestone (100, 500, 1000, etc.).',
    defaultEnabled: true,
    requiresReferenceFile: null,
  },
  {
    id: 'placed_year_2000',
    displayName: 'Year-2000 Cache',
    severity: 'featured',
    description: 'Found a cache placed in the year 2000 — the first year of geocaching.',
    defaultEnabled: true,
    requiresReferenceFile: null,
  },
  {
    id: 'placed_year_2001',
    displayName: 'Year-2001 Cache',
    severity: 'featured',
    description: 'Found a cache placed in 2001, in the very early days of geocaching.',
    defaultEnabled: true,
    requiresReferenceFile: null,
  },
  {
    id: 'type_virtual',
    displayName: 'Virtual Cache',
    severity: 'featured',
    description: 'Found a Virtual cache — a cache type no longer available for new placements.',
    defaultEnabled: true,
    requiresReferenceFile: null,
  },
  {
    id: 'new_county',
    displayName: 'New County',
    severity: 'note',
    description: 'First find in a new county.',
    defaultEnabled: true,
    requiresReferenceFile: null,
  },
  {
    id: 'new_state',
    displayName: 'New State',
    severity: 'featured',
    description: 'First find in a new US state.',
    defaultEnabled: true,
    requiresReferenceFile: null,
  },
  {
    id: 'new_country',
    displayName: 'New Country',
    severity: 'marquee',
    description: 'First find in a new country.',
    defaultEnabled: true,
    requiresReferenceFile: null,
  },
  {
    id: 'state_completion',
    displayName: 'State County Completion',
    severity: 'marquee',
    description: 'Completed all counties in a US state.',
    defaultEnabled: true,
    requiresReferenceFile: null,
  },
  {
    id: 'high_fav_250',
    displayName: 'Highly Favorited (250+)',
    severity: 'note',
    description: 'Found a cache with 250 or more favorite points.',
    defaultEnabled: true,
    requiresReferenceFile: null,
  },
  {
    id: 'high_fav_500',
    displayName: 'Highly Favorited (500+)',
    severity: 'note',
    description: 'Found a cache with 500 or more favorite points.',
    defaultEnabled: true,
    requiresReferenceFile: null,
  },
  {
    id: 'high_fav_1000',
    displayName: 'Highly Favorited (1000+)',
    severity: 'featured',
    description: 'Found a cache with 1000 or more favorite points.',
    defaultEnabled: true,
    requiresReferenceFile: null,
  },
  {
    id: 'jasmer_grid_fill',
    displayName: 'Jasmer Grid Fill',
    severity: 'featured',
    description: 'Found a cache that fills a new cell in the Jasmer grid (month/year of placement).',
    defaultEnabled: true,
    requiresReferenceFile: null,
  },
  {
    id: 'dt_grid_fill',
    displayName: 'D/T Grid Fill',
    severity: 'note',
    description: 'Found a cache that fills a new cell in the Difficulty/Terrain grid.',
    defaultEnabled: true,
    requiresReferenceFile: null,
  },
  {
    id: 'oldest_active_per_state',
    displayName: 'Oldest Active Cache per State',
    severity: 'marquee',
    description: 'Found the oldest active cache in a US state.',
    defaultEnabled: true,
    requiresReferenceFile: 'oldest_active_per_state.gpx',
  },
  {
    id: 'oldest_active_per_country',
    displayName: 'Oldest Active Cache per Country',
    severity: 'marquee',
    description: 'Found the oldest active cache in a country.',
    defaultEnabled: true,
    requiresReferenceFile: 'oldest_active_per_country.gpx',
  },
  {
    id: 'cache_across_america',
    displayName: 'Cache Across America',
    severity: 'featured',
    description: 'Found a Cache Across America cache.',
    defaultEnabled: true,
    requiresReferenceFile: 'cache_across_america.gpx',
  },
  {
    id: 'cache_odyssey',
    displayName: 'Cache Odyssey',
    severity: 'featured',
    description: 'Found a Cache Odyssey cache.',
    defaultEnabled: true,
    requiresReferenceFile: 'cache_odyssey.gpx',
  },
];
