const NCEI = 'https://www.ncei.noaa.gov/access/services';
const STATION_SEARCH = 'https://gis.ncdc.noaa.gov/arcgis/rest/services/cdo/ghcnd/MapServer/0/query';
const DATASET = 'daily-summaries';
const SOURCE = 'NOAA National Centers for Environmental Information (NCEI), GHCN-Daily (https://doi.org/10.7289/V5D21VHZ)';
const DAY_MS = 86_400_000;
const WINDOW_DAYS = 366;
export const MAX_STATIONS = 10;
const US_STATION_ID = /^US[A-Z0-9]{9}$/;
// The NCEI GIS layer stores full state names, while Actor inputs use USPS codes.
const STATE_NAMES = {
    AL: 'Alabama',
    AK: 'Alaska',
    AZ: 'Arizona',
    AR: 'Arkansas',
    CA: 'California',
    CO: 'Colorado',
    CT: 'Connecticut',
    DE: 'Delaware',
    DC: 'District of Columbia',
    FL: 'Florida',
    GA: 'Georgia',
    HI: 'Hawaii',
    ID: 'Idaho',
    IL: 'Illinois',
    IN: 'Indiana',
    IA: 'Iowa',
    KS: 'Kansas',
    KY: 'Kentucky',
    LA: 'Louisiana',
    ME: 'Maine',
    MD: 'Maryland',
    MA: 'Massachusetts',
    MI: 'Michigan',
    MN: 'Minnesota',
    MS: 'Mississippi',
    MO: 'Missouri',
    MT: 'Montana',
    NE: 'Nebraska',
    NV: 'Nevada',
    NH: 'New Hampshire',
    NJ: 'New Jersey',
    NM: 'New Mexico',
    NY: 'New York',
    NC: 'North Carolina',
    ND: 'North Dakota',
    OH: 'Ohio',
    OK: 'Oklahoma',
    OR: 'Oregon',
    PA: 'Pennsylvania',
    RI: 'Rhode Island',
    SC: 'South Carolina',
    SD: 'South Dakota',
    TN: 'Tennessee',
    TX: 'Texas',
    UT: 'Utah',
    VT: 'Vermont',
    VA: 'Virginia',
    WA: 'Washington',
    WV: 'West Virginia',
    WI: 'Wisconsin',
    WY: 'Wyoming',
};

const DEFAULT_TYPES = ['TMAX', 'TMIN', 'PRCP', 'SNOW', 'SNWD', 'AWND'];
const DATA_TYPES = new Set([
    ...DEFAULT_TYPES, 'TAVG', 'ADPT', 'ASLP', 'ASTP', 'WDF2', 'WDF5', 'WSF2', 'WSF5',
]);

// GHCN-Daily readme, section III (SFLAG1). COOP is an NWS program that includes
// volunteers. These flags identify the program or feed for each observation.
const FEDERAL_SOURCES = new Set([
    '0', '6', '7', 'K', // U.S. Cooperative Summary of the Day
    '1', 'D', 'd',     // NWS CF6 and Daily Summary Messages
    'A', 'B', 'M', 'W', // ASOS and WBAN/ASOS
    'F', 'X',          // U.S. Fort and U.S. First-Order records
    'R', 'T',          // NCEI Reference Network and USDA SNOTEL
]);

const isObject = (value) => value !== null && typeof value === 'object' && !Array.isArray(value);
const formatDate = (ms) => new Date(ms).toISOString().slice(0, 10);
const isDate = (value) => {
    if (typeof value !== 'string' || !/^\d{4}-\d{2}-\d{2}$/.test(value) || value.startsWith('0000-')) return false;
    const ms = Date.parse(value);
    return Number.isFinite(ms) && formatDate(ms) === value;
};

export function normalizeInput(input) {
    if (!isObject(input)) throw new Error('Input must be an object.');
    const { startDate, endDate, units = 'metric', dataTypes = DEFAULT_TYPES, stationSearch, stations = [] } = input;
    if (!isDate(startDate) || !isDate(endDate) || startDate > endDate) {
        throw new Error('Use valid YYYY-MM-DD dates with startDate on or before endDate.');
    }
    if (units !== 'metric' && units !== 'standard') throw new Error('units must be metric or standard.');
    if (!Array.isArray(dataTypes) || dataTypes.length === 0 || !dataTypes.every((type) => DATA_TYPES.has(type))) {
        throw new Error('dataTypes must be a non-empty array of supported GHCN-Daily codes. See the README.');
    }
    if (!Array.isArray(stations) || !stations.every((station) => (
        typeof station === 'string' && US_STATION_ID.test(station)
    ))) {
        throw new Error('stations must contain 11-character U.S. GHCN-Daily station IDs starting with US.');
    }
    if (stations.length > MAX_STATIONS) throw new Error(`stations accepts at most ${MAX_STATIONS} station IDs.`);
    if ((stations.length > 0) === (stationSearch !== undefined)) {
        throw new Error('Provide either stations or stationSearch.');
    }
    const search = stationSearch === undefined ? null : normalizeSearch(stationSearch);
    return {
        startDate, endDate, units, dataTypes: [...new Set(dataTypes)], search,
        stations: [...new Set(stations)],
    };
}

function normalizeSearch(search) {
    if (!isObject(search) || Object.keys(search).some((key) => key !== 'state' && key !== 'bbox')) {
        throw new Error('stationSearch must contain state, bbox, or both.');
    }
    const { state, bbox } = search;
    if (state === undefined && bbox === undefined) throw new Error('stationSearch requires state or bbox.');
    if (state !== undefined && (typeof state !== 'string' || !Object.hasOwn(STATE_NAMES, state))) {
        throw new Error('stationSearch.state must be a two-letter uppercase U.S. state code.');
    }
    if (bbox !== undefined) {
        if (!Array.isArray(bbox) || bbox.length !== 4 || !bbox.every(Number.isFinite)) {
            throw new Error('stationSearch.bbox must contain four numbers in north, west, south, east order.');
        }
        const [north, west, south, east] = bbox;
        if (north > 90 || south < -90 || west < -180 || east > 180 || north < south || east < west) {
            throw new Error('stationSearch.bbox coordinates must be ordered and within latitude and longitude bounds.');
        }
    }
    return { state, bbox };
}

export function* dateWindows(startDate, endDate) {
    const firstDay = Date.parse(startDate);
    const lastDay = Date.parse(endDate);
    for (let start = firstDay; start <= lastDay; start += WINDOW_DAYS * DAY_MS) {
        const end = Math.min(lastDay, start + (WINDOW_DAYS - 1) * DAY_MS);
        yield { startDate: formatDate(start), endDate: formatDate(end) };
    }
}

export function searchUrl({ startDate, endDate, search }) {
    const url = new URL(STATION_SEARCH);
    const where = [
        "(STATION_ID LIKE 'US%' OR STATION_ID LIKE 'GHCND:US%')",
        `DATA_BEGIN_DATE <= DATE '${endDate}'`,
        `DATA_END_DATE >= DATE '${startDate}'`,
    ];
    if (search.state) where.push(`STATE = '${STATE_NAMES[search.state]}'`);
    url.search = new URLSearchParams({
        where: where.join(' AND '),
        outFields: 'STATION_ID',
        returnDistinctValues: 'true',
        returnGeometry: 'false',
        orderByFields: 'STATION_ID DESC',
        resultRecordCount: String(MAX_STATIONS + 1),
        f: 'json',
    });
    if (search.bbox) {
        const [north, west, south, east] = search.bbox;
        url.searchParams.set('geometryType', 'esriGeometryEnvelope');
        url.searchParams.set('geometry', [west, south, east, north].join(','));
        url.searchParams.set('inSR', '4326');
    }
    return url;
}

export function dataUrl({ stations, units, dataTypes }, { startDate, endDate }) {
    const url = new URL(`${NCEI}/data/v1`);
    url.search = new URLSearchParams({
        dataset: DATASET,
        stations: stations.join(','),
        startDate,
        endDate,
        dataTypes: dataTypes.join(','),
        units,
        includeAttributes: 'true',
        includeStationName: 'true',
        format: 'json',
    });
    return url;
}

export function parseSearch(payload) {
    if (!isObject(payload) || !Array.isArray(payload.features) || payload.error) {
        throw new Error('Unrecognized NOAA station search response. Expected GIS station features.');
    }
    const matches = new Set();
    for (const feature of payload.features) {
        const id = feature?.attributes?.STATION_ID;
        const station = typeof id === 'string' ? id.replace(/^GHCND:/, '') : '';
        if (!US_STATION_ID.test(station)) {
            throw new Error('NOAA station search returned an invalid U.S. GHCN-Daily station ID.');
        }
        matches.add(station);
    }
    return {
        stations: [...matches].slice(0, MAX_STATIONS),
        truncated: matches.size > MAX_STATIONS || payload.exceededTransferLimit === true,
    };
}

function parseAttributes(raw) {
    if (typeof raw !== 'string') throw new Error('Unrecognized NOAA observation attributes.');
    const parts = raw.split(',').map((part) => part.trim());
    const [measurementFlag, qualityFlag, sourceFlag, time = ''] = parts;
    if (parts.length < 3 || parts.length > 4 || !/^[A-Z]?$/.test(measurementFlag)
        || !/^[A-Z]?$/.test(qualityFlag) || !/^[A-Za-z0-9]?$/.test(sourceFlag)
        || !/^(?:\d{4})?$/.test(time)) {
        throw new Error('Unrecognized NOAA observation attributes.');
    }
    return { measurementFlag: measurementFlag || null, qualityFlag: qualityFlag || null, sourceFlag };
}

function parseValue(raw) {
    if (raw === undefined || raw === null) return null;
    const value = typeof raw === 'string' ? raw.trim() : raw;
    if (value === '') return null;
    if ((typeof value !== 'number' && (typeof value !== 'string' || !/^[+-]?\d+(?:\.\d+)?$/.test(value)))
        || !Number.isFinite(Number(value))) {
        throw new Error('Unrecognized NOAA observation value.');
    }
    const number = Number(value);
    return number === -9999 || number === 9999 ? null : number;
}

function readObservation(record, type) {
    const raw = record[type];
    const rawAttributes = record[`${type}_ATTRIBUTES`];
    if (rawAttributes === undefined || rawAttributes === null || rawAttributes === '') {
        if (parseValue(raw) !== null) throw new Error('NOAA returned an observation without its requested attributes.');
        return { value: null, flags: null };
    }
    const flags = parseAttributes(rawAttributes);
    const { sourceFlag, measurementFlag, qualityFlag } = flags;
    const reported = parseValue(raw);
    if (!FEDERAL_SOURCES.has(sourceFlag)) {
        const excluded = reported !== null || sourceFlag !== '';
        return { value: null, flags: excluded ? { ...flags, excludedBySource: true } : null };
    }
    const value = qualityFlag || measurementFlag === 'P' ? null : reported;
    return { value, flags };
}

export function parseDaily(payload, { stations, dataTypes, units }, { startDate, endDate }) {
    if (!Array.isArray(payload)) throw new Error('Unrecognized NOAA daily observations response. Expected a JSON array.');
    const expectedKeys = new Set(['STATION', 'DATE', 'NAME', ...dataTypes, ...dataTypes.map((type) => `${type}_ATTRIBUTES`)]);
    const seen = new Set();
    const rows = [];
    for (const record of payload) {
        if (!isObject(record) || !stations.includes(record.STATION) || !isDate(record.DATE)
            || record.DATE < startDate || record.DATE > endDate
            || (record.NAME != null && typeof record.NAME !== 'string')) {
            throw new Error('NOAA returned an invalid station, date, or station name.');
        }
        if (Object.keys(record).some((key) => !expectedKeys.has(key))) {
            throw new Error('NOAA returned unexpected fields in a daily observation.');
        }
        const { STATION: station, DATE: date } = record;
        const key = `${station}/${date}`;
        if (seen.has(key)) throw new Error('NOAA returned a duplicate station and date.');
        seen.add(key);
        const values = {};
        const attributes = {};
        for (const type of dataTypes) {
            const { value, flags } = readObservation(record, type);
            values[type] = value;
            attributes[type] = flags;
        }
        if (Object.values(attributes).some((flags) => flags !== null)) {
            rows.push({ station, name: record.NAME?.trim() || null, date, units, values, attributes, source: SOURCE });
        }
    }
    return rows.sort((a, b) => a.date.localeCompare(b.date) || a.station.localeCompare(b.station));
}

export function sanitize(message) {
    return String(message).split(/[\r\n]/, 1)[0]
        .replace(/(["'])(?:[A-Za-z]:[\\/]|\/|\\\\)[^"']+\1/g, '$1<path>$1')
        .replace(/[A-Za-z]:[\\/](?:[^\s"'<>|]+)|\/(?:[^\s"'<>|/]+\/)+[^\s"'<>|/]+/g, '<path>');
}
