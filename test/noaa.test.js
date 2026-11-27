import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { dateWindows, MAX_STATIONS, normalizeInput, parseDaily, parseSearch, sanitize } from '../src/noaa.js';
import { runActor } from '../src/run.js';

const load = async (name) => JSON.parse(await readFile(new URL(`./fixtures/${name}.json`, import.meta.url), 'utf8'));
const [centralPark, standard, metadata] = await Promise.all([
    load('central-park-metric'), load('daily-standard'), load('station-search'),
]);
const INPUT = { stations: ['USW00094728'], startDate: '2026-10-01', endDate: '2026-10-07' };

test('accepts any well-formed U.S. station ID and validates the input limits', () => {
    assert.deepEqual(normalizeInput({ ...INPUT, stations: [...INPUT.stations, ...INPUT.stations] }).stations, INPUT.stations);
    const stations = ['USW00023174', 'USC00457180', 'US1NYNY0074'];
    assert.deepEqual(normalizeInput({ ...INPUT, stations }).stations, stations);
    assert.equal(normalizeInput(INPUT).units, 'metric');
    for (const [input, message] of [
        [{ stations: ['CA001234567'] }, /starting with US/],
        [{ stations: ['USW0002317'] }, /11-character/],
        [{ stations: ['USW00023174\n'] }, /11-character/],
        [{ stations: ['constructor'] }, /starting with US/],
        [{ stations: Array(MAX_STATIONS + 1).fill('USW00023174') }, /at most 10/],
        [{ stations: [] }, /either stations or stationSearch/],
        [{ startDate: '2026-02-29' }, /valid YYYY-MM-DD/],
        [{ startDate: '2026-10-08' }, /valid YYYY-MM-DD/],
        [{ dataTypes: ['DATE'] }, /supported GHCN-Daily/],
        [{ units: 'imperial' }, /metric or standard/],
        [{ stationSearch: { state: 'NY' } }, /either stations or stationSearch/],
        [{ stations: [], stationSearch: { state: 'CA OR' } }, /two-letter/],
        [{ stations: [], stationSearch: { state: 'ZZ' } }, /two-letter/],
        [{ stations: [], stationSearch: { bbox: [40, -70, 41, -72] } }, /ordered/],
    ]) assert.throws(() => normalizeInput({ ...INPUT, ...input }), message);
});

test('splits inclusive windows across leap day without overlaps or gaps', () => {
    assert.deepEqual([...dateWindows('2019-03-01', '2020-03-01')], [
        { startDate: '2019-03-01', endDate: '2020-02-29' },
        { startDate: '2020-03-01', endDate: '2020-03-01' },
    ]);
    assert.deepEqual([...dateWindows('1995-10-31', '1995-11-01')], [
        { startDate: '1995-10-31', endDate: '1995-11-01' },
    ]);
});

test('parses published dates and trace and true zero with missing observations', () => {
    const withVolunteerSnow = [
        { ...centralPark[0], SNOW: '7.5', SNOW_ATTRIBUTES: ',,N,2400', SNWD: '15', SNWD_ATTRIBUTES: ',,N,2400' },
        ...centralPark.slice(1),
    ];
    const rows = parseDaily(withVolunteerSnow, normalizeInput(INPUT), INPUT);
    assert.equal(rows.length, 7);
    assert.deepEqual(rows.map((row) => row.date), centralPark.map((row) => row.DATE));
    assert.equal(rows[0].name, 'NY CITY CENTRAL PARK, NY US');
    assert.equal(rows[0].values.PRCP, 0);
    assert.equal(rows[0].attributes.PRCP.measurementFlag, null);
    assert.equal(rows[1].values.PRCP, 0);
    assert.deepEqual(rows[1].attributes.PRCP, { measurementFlag: 'T', qualityFlag: null, sourceFlag: '1' });
    assert.equal(rows[3].values.PRCP, 3.8);
    assert.equal(rows[0].values.SNOW, null);
    assert.deepEqual(rows[0].attributes.SNOW, {
        measurementFlag: null, qualityFlag: null, sourceFlag: 'N', excludedBySource: true,
    });
    assert.equal(rows[6].values.SNWD, null);
    assert.equal(rows[6].attributes.SNWD, null);
    assert.match(rows[0].source, /NOAA.*GHCN-Daily/);
});

test('preserves standard units and airport snow, with nulls for omitted readings', () => {
    const input = {
        stations: ['USW00094789'], units: 'standard', startDate: '2026-10-04', endDate: '2026-10-04',
        dataTypes: ['TMAX', 'TMIN', 'PRCP', 'SNOW', 'SNWD', 'AWND', 'ADPT', 'WDF2', 'WDF5', 'WSF2', 'WSF5'],
    };
    const [row] = parseDaily(standard, normalizeInput(input), input);
    assert.equal(row.units, 'standard');
    assert.equal(row.values.TMAX, 64);
    assert.equal(row.values.PRCP, 0.23);
    assert.equal(row.values.SNOW, 0);
    assert.equal(row.values.WDF2, 70);
    assert.equal(row.values.ADPT, null);
    assert.equal(row.attributes.ADPT, null);
});

test('flags source exclusions per element, including when the entire day is excluded', () => {
    const raw = [{
        STATION: 'USW00094728', DATE: '2026-10-03',
        TMAX: '0.0', TMAX_ATTRIBUTES: ',,A',
        TMIN: '-4.7', TMIN_ATTRIBUTES: ',X,1',
        PRCP: '0', PRCP_ATTRIBUTES: 'P,,d',
        AWND: '3.2', AWND_ATTRIBUTES: ',X,a',
    }, {
        STATION: 'USW00094728', DATE: '2026-10-04',
        TMAX: '9999', TMAX_ATTRIBUTES: ',,1',
        TMIN: '-9999', TMIN_ATTRIBUTES: ',,W',
        AWND: '0', AWND_ATTRIBUTES: ',,',
    }, {
        STATION: 'USW00094728', DATE: '2026-10-05',
        PRCP: '19.2', PRCP_ATTRIBUTES: ',,N',
        AWND: '0', AWND_ATTRIBUTES: ',,',
    }];
    const rows = parseDaily(raw, normalizeInput(INPUT), INPUT);
    assert.equal(rows.length, 3);
    assert.equal(rows[0].name, null);
    assert.deepEqual(rows[0].values, { TMAX: 0, TMIN: null, PRCP: null, SNOW: null, SNWD: null, AWND: null });
    assert.equal(rows[0].attributes.TMIN.qualityFlag, 'X');
    assert.equal(rows[0].attributes.PRCP.measurementFlag, 'P');
    assert.deepEqual(rows[0].attributes.AWND, {
        measurementFlag: null, qualityFlag: 'X', sourceFlag: 'a', excludedBySource: true,
    });
    assert.equal(rows[1].values.TMAX, null);
    assert.equal(rows[1].values.TMIN, null);
    assert.equal(rows[1].values.AWND, null);
    assert.equal(rows[1].attributes.AWND.excludedBySource, true);
    assert.equal(rows[2].values.PRCP, null);
    assert.equal(rows[2].attributes.PRCP.excludedBySource, true);
    assert.equal(rows[2].attributes.AWND.excludedBySource, true);
});

test('uses the documented source flags at historical stations and for all requested elements', () => {
    const input = {
        stations: ['USC00457180'], startDate: '1900-01-01', endDate: '1900-01-01', dataTypes: ['SNOW'],
    };
    const options = normalizeInput(input);
    const accepted = ['0', '6', '7', 'K', '1', 'D', 'd', 'A', 'B', 'M', 'W', 'F', 'X', 'R', 'T'];
    const excluded = ['2', 'a', 'b', 'C', 'E', 'G', 'H', 'I', 'f', 'm', 'N', 'Q', 'r', 'S', 's', 'U', 'u', 'Z', 'z', 'Y'];
    for (const flag of [...accepted, ...excluded]) {
        const [row] = parseDaily([{
            STATION: input.stations[0], DATE: input.startDate, SNOW: '7.5', SNOW_ATTRIBUTES: `,,${flag}`,
        }], options, input);
        assert.equal(row.values.SNOW, accepted.includes(flag) ? 7.5 : null, flag);
        assert.equal(row.attributes.SNOW.excludedBySource, accepted.includes(flag) ? undefined : true, flag);
    }
});

test('requests the entire historical range for an explicit station', async () => {
    const requests = [];
    const waits = [];
    const count = await runActor({ ...INPUT, startDate: '1994-03-01', endDate: '1995-03-02' }, {
        actor: { pushData: () => assert.fail('Unexpected dataset write') },
        fetchImpl: async (url) => {
            requests.push(Object.fromEntries(url.searchParams));
            return Response.json([]);
        },
        sleep: async (ms) => waits.push(ms),
    });
    assert.equal(count, 0);
    assert.deepEqual(waits, [2200]);
    assert.deepEqual(requests.map(({ stations, startDate, endDate }) => [stations, startDate, endDate]), [
        ['USW00094728', '1994-03-01', '1995-03-01'],
        ['USW00094728', '1995-03-02', '1995-03-02'],
    ]);
});

test('rejects unknown daily response formats and malformed records', () => {
    const options = normalizeInput(INPUT);
    assert.throws(() => parseDaily({ results: [] }, options, INPUT), /expected a JSON array/i);
    for (const [row, message] of [
        [{ DATE: '2026-10-09' }, /invalid station, date/],
        [{ STATION: 'USW00094789' }, /invalid station, date/],
        [{ TMAX_ATTRIBUTES: undefined }, /without its requested attributes/],
        [{ TMAX_ATTRIBUTES: 'not a flag' }, /unrecognized NOAA observation attributes/i],
        [{ UNEXPECTED: 'bad' }, /unexpected fields/],
    ]) assert.throws(() => parseDaily([{ ...centralPark[0], ...row }], options, INPUT), message);
    assert.throws(() => parseDaily([centralPark[0], centralPark[0]], options, INPUT), /duplicate/);
    assert.deepEqual(parseDaily([], options, INPUT), []);
    assert.deepEqual(parseDaily([{ STATION: 'USW00094728', DATE: '2026-10-01' }], options, INPUT), []);
});

test('queries the GIS bounding box and then fetches only the returned stations', async () => {
    const requests = [];
    const waits = [];
    const rows = [];
    const input = {
        startDate: INPUT.startDate, endDate: INPUT.endDate, stationSearch: { bbox: [40.8, -74, 40.75, -73.94] },
    };
    const count = await runActor(input, {
        actor: { pushData: async (items) => rows.push(...items) },
        fetchImpl: async (url, options) => {
            requests.push(url);
            assert.equal(options.redirect, 'manual');
            return Response.json(requests.length === 1 ? metadata : centralPark);
        },
        sleep: async (ms) => waits.push(ms),
    });
    assert.equal(count, 7);
    assert.equal(rows.length, 7);
    assert.deepEqual(waits, [2200]);
    assert.equal(requests[0].pathname, '/arcgis/rest/services/cdo/ghcnd/MapServer/0/query');
    assert.equal(requests[0].searchParams.get('geometryType'), 'esriGeometryEnvelope');
    assert.equal(requests[0].searchParams.get('geometry'), '-74,40.75,-73.94,40.8');
    assert.equal(requests[0].searchParams.get('inSR'), '4326');
    assert.match(requests[0].searchParams.get('where'), /DATA_BEGIN_DATE <= DATE '2026-10-07' AND DATA_END_DATE >= DATE '2026-10-01'/);
    assert.doesNotMatch(requests[0].searchParams.get('where'), /STATE/);
    assert.equal(requests[1].pathname, '/access/services/data/v1');
    assert.equal(requests[1].searchParams.get('stations'), 'USW00094728');
    assert.equal(requests[1].searchParams.get('includeAttributes'), 'true');
    assert.equal(requests[1].searchParams.get('includeStationName'), 'true');
});

test('queries by state alone and treats a valid empty search explicitly', async () => {
    const warnings = [];
    const requests = [];
    const count = await runActor({ ...INPUT, stations: [], stationSearch: { state: 'CA' } }, {
        actor: { pushData: () => assert.fail('Unexpected dataset write') },
        fetchImpl: async (url) => {
            requests.push(url);
            return Response.json({ features: [] });
        },
        warn: (message) => warnings.push(message),
    });
    assert.equal(count, 0);
    assert.equal(requests.length, 1);
    assert.match(requests[0].searchParams.get('where'), /STATE = 'California'/);
    assert.equal(requests[0].searchParams.has('geometry'), false);
    assert.match(warnings[0], /No U.S. GHCN-Daily station/);
});

test('intersects state and bounding box and caps distinct search matches', async () => {
    const requests = [];
    const warnings = [];
    const ids = Array.from({ length: MAX_STATIONS + 1 }, (_, i) => `USW000231${90 - i}`);
    const features = [`GHCND:${ids[0]}`, ...ids].map((STATION_ID) => ({ attributes: { STATION_ID } }));
    await runActor({
        ...INPUT, stations: [], stationSearch: { state: 'CA', bbox: [42, -125, 32, -114] },
    }, {
        actor: { pushData: () => assert.fail('Unexpected dataset write') },
        fetchImpl: async (url) => {
            requests.push(url);
            return Response.json(requests.length === 1 ? { features } : []);
        },
        sleep: async () => {},
        warn: (message) => warnings.push(message),
    });
    assert.match(requests[0].searchParams.get('where'), /STATE = 'California'/);
    assert.equal(requests[0].searchParams.get('geometry'), '-125,32,-114,42');
    assert.equal(requests[0].searchParams.get('returnDistinctValues'), 'true');
    assert.equal(requests[0].searchParams.get('resultRecordCount'), '11');
    assert.deepEqual(requests[1].searchParams.get('stations').split(','), ids.slice(0, MAX_STATIONS));
    assert.match(warnings[0], /limited to 10 IDs/);
});

test('distinguishes truncated and malformed GIS search responses', () => {
    assert.deepEqual(parseSearch({ ...metadata, exceededTransferLimit: true }), {
        stations: ['USW00094728'], truncated: true,
    });
    assert.throws(() => parseSearch({ error: { code: 400 } }), /expected GIS station features/i);
    assert.throws(() => parseSearch({ features: [{ attributes: { STATION_ID: 'CA001234567' } }] }), /invalid U.S./);
});

test('honors Retry-After and backs off after a transient HTTP or network failure', async () => {
    const waits = [];
    const attempts = [
        () => new Response(null, { status: 429, headers: { 'Retry-After': '12' } }),
        () => new Response(null, { status: 503 }),
        () => { throw new TypeError('fetch failed'); },
        () => Response.json(centralPark),
    ];
    const count = await runActor(INPUT, {
        actor: { pushData: async () => {} },
        fetchImpl: async () => attempts.shift()(),
        sleep: async (ms) => waits.push(ms),
    });
    assert.equal(count, 7);
    assert.equal(attempts.length, 0);
    assert.deepEqual(waits, [12000, 4400, 8800]);
});

test('stops on access denial or a redirect and caps transient retries', async () => {
    for (const [status, total] of [[403, 1], [302, 1], [503, 4]]) {
        let calls = 0;
        await assert.rejects(runActor(INPUT, {
            actor: { pushData: () => assert.fail('Unexpected dataset write') },
            fetchImpl: async () => {
                calls += 1;
                return new Response(null, { status });
            },
            sleep: async () => {},
        }), new RegExp(`HTTP ${status}`));
        assert.equal(calls, total);
    }
});

test('removes paths and following stack frames from error messages', () => {
    const path = ['C:', 'Users', 'example', 'file'].join('\\');
    assert.equal(sanitize(`Cannot open "${path}"\n  at run (ignored)`), 'Cannot open "<path>"');
    assert.equal(sanitize(`Cannot open '${path} with spaces'`), "Cannot open '<path>'");
    assert.equal(sanitize('Cannot open /tmp/actor/file'), 'Cannot open <path>');
});

test('prechecks the dataset item budget and allows non-PPE output', async () => {
    for (const [isPayPerEvent, budget] of [[true, 1], [true, 0], [false, 0]]) {
        const configureActor = (actor, records) => {
            actor.getChargingManager = () => ({
                getPricingInfo: () => ({ isPayPerEvent }),
                calculateMaxEventChargeCountWithinLimit(event) {
                    assert.equal(event, 'apify-default-dataset-item');
                    return budget - records.length;
                },
            });
        };
        const rows = [];
        let summary;
        const actor = {
            pushData: async (batch) => rows.push(...batch),
            setValue: async (_, value) => { summary = value; },
        };
        configureActor(actor, rows);
        const expected = isPayPerEvent ? budget : centralPark.length;
        const count = await runActor(INPUT, { actor, fetchImpl: async () => Response.json(centralPark) });
        assert.equal(count, expected);
        assert.equal(rows.length, expected);
        assert.equal(summary?.stopReason, isPayPerEvent ? 'spendingLimit' : undefined);
    }
});
