/**
 * County geocoding via Mapbox reverse geocoding API.
 *
 * We only geocode caches that were:
 *   1. Loaded from a PQ GPX (no county info in the file)
 *   2. Not already geocoded (county_source IS NULL)
 *
 * Once geocoded, the result is cached forever in the `caches` table.
 * So volume is dramatically low — a few hundred to a few thousand
 * calls over the app's lifetime, well within Mapbox's free tier
 * (100k requests/month).
 */

// State/region name → USPS abbreviation (for US and Canada)
const REGION_TO_ABBREV: Record<string, string> = {
  // US States
  'Alabama':'AL','Alaska':'AK','Arizona':'AZ','Arkansas':'AR','California':'CA',
  'Colorado':'CO','Connecticut':'CT','Delaware':'DE','District of Columbia':'DC',
  'Florida':'FL','Georgia':'GA','Hawaii':'HI','Idaho':'ID','Illinois':'IL',
  'Indiana':'IN','Iowa':'IA','Kansas':'KS','Kentucky':'KY','Louisiana':'LA',
  'Maine':'ME','Maryland':'MD','Massachusetts':'MA','Michigan':'MI','Minnesota':'MN',
  'Mississippi':'MS','Missouri':'MO','Montana':'MT','Nebraska':'NE','Nevada':'NV',
  'New Hampshire':'NH','New Jersey':'NJ','New Mexico':'NM','New York':'NY',
  'North Carolina':'NC','North Dakota':'ND','Ohio':'OH','Oklahoma':'OK','Oregon':'OR',
  'Pennsylvania':'PA','Rhode Island':'RI','South Carolina':'SC','South Dakota':'SD',
  'Tennessee':'TN','Texas':'TX','Utah':'UT','Vermont':'VT','Virginia':'VA',
  'Washington':'WA','West Virginia':'WV','Wisconsin':'WI','Wyoming':'WY',
  'Puerto Rico':'PR','U.S. Virgin Islands':'VI','Guam':'GU','American Samoa':'AS',
  // Canadian provinces
  'Alberta':'AB','British Columbia':'BC','Manitoba':'MB','New Brunswick':'NB',
  'Newfoundland and Labrador':'NL','Nova Scotia':'NS','Ontario':'ON',
  'Prince Edward Island':'PE','Quebec':'QC','Saskatchewan':'SK',
  'Northwest Territories':'NT','Nunavut':'NU','Yukon':'YT',
};

interface MapboxContext {
  id: string;
  text: string;
  short_code?: string;
  wikidata?: string;
}

interface MapboxFeature {
  id: string;
  place_type: string[];
  text: string;
  place_name: string;
  context?: MapboxContext[];
}

interface MapboxResponse {
  features?: MapboxFeature[];
}

/**
 * Reverse-geocode a single lat/lon point. Returns {county, state} in USPS
 * abbreviation form for state, or null if lookup failed or point is outside
 * a supported region.
 *
 * Mapbox returns 'district' as the county context in the US. The state
 * comes from the 'region' context with short_code like 'US-CO'.
 */
export async function geocodePoint(
  lat: number,
  lon: number,
  mapboxToken: string,
): Promise<{ county: string; state: string } | null> {
  const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${lon},${lat}.json?` +
    `access_token=${mapboxToken}&types=district,region&limit=1`;

  try {
    const resp = await fetch(url, { signal: AbortSignal.timeout(4000) });
    if (!resp.ok) return null;
    const data = await resp.json() as MapboxResponse;
    if (!data.features?.length) return null;

    let county: string | null = null;
    let stateAbbrev: string | null = null;
    let countryCode: string | null = null;

    for (const feat of data.features) {
      if (feat.place_type.includes('district')) {
        county = normalizeCountyName(feat.text);
      }
      if (feat.context) {
        for (const ctx of feat.context) {
          if (ctx.id.startsWith('district.')) {
            county = normalizeCountyName(ctx.text);
          }
          if (ctx.id.startsWith('region.')) {
            // short_code format: 'US-CO' or 'CA-ON'
            if (ctx.short_code) {
              const parts = ctx.short_code.split('-');
              if (parts.length === 2) {
                countryCode = parts[0].toUpperCase();
                stateAbbrev = parts[1].toUpperCase();
              }
            }
            if (!stateAbbrev) stateAbbrev = REGION_TO_ABBREV[ctx.text] ?? null;
          }
          if (ctx.id.startsWith('country.') && ctx.short_code) {
            countryCode = ctx.short_code.toUpperCase();
          }
        }
      }
    }

    // Only return county attribution for US and Canada — other countries don't
    // have county-style subdivisions that map to our county grid.
    if (countryCode && countryCode !== 'US' && countryCode !== 'CA') return null;

    if (county && stateAbbrev) {
      return { county, state: stateAbbrev };
    }
    return null;
  } catch {
    return null;
  }
}

/** Strip "County", "Parish", "Borough" suffix so we match TIGER-style names. */
function normalizeCountyName(name: string): string {
  return name
    .replace(/ County$/i, '')
    .replace(/ Parish$/i, '')
    .replace(/ Borough$/i, '')
    .replace(/ Census Area$/i, '')
    .replace(/ Municipality$/i, '')
    .trim();
}
