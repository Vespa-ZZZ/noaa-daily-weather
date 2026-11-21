# NOAA Daily Weather History

Retrieve historical daily observations from NOAA's National Centers for Environmental Information (NCEI). Each dataset item represents one published station and observation date. Use the results to compare weather across sites, join daily observations to location-based records, or audit precipitation traces and quality flags. The Actor uses NOAA's public APIs without an API key.

## Input

Run by GHCN-Daily station ID. Both dates are inclusive.

```json
{
  "stations": ["USW00023174"],
  "startDate": "2024-01-15",
  "endDate": "2024-01-21"
}
```

To discover stations with NCEI's GHCN-Daily GIS API, use `stationSearch` in place of `stations`. Use a two-letter state code, a bounding box in `[north, west, south, east]` order, or both. When both are supplied, the search uses their intersection. Search uses NOAA's published station coverage dates and selects up to 10 matching U.S. station IDs in descending order. The Actor warns if the result is truncated. Use a smaller bounding box or explicit IDs to select other stations. [NCEI GHCN-Daily GIS layer](https://gis.ncdc.noaa.gov/arcgis/rest/services/cdo/ghcnd/MapServer/0)

```json
{
  "stationSearch": { "state": "CA", "bbox": [34.1, -118.6, 33.9, -118.2] },
  "startDate": "2024-01-15",
  "endDate": "2024-01-21",
  "dataTypes": ["TMAX", "PRCP", "SNOW"],
  "units": "metric"
}
```

| Input | Accepted values |
| --- | --- |
| `stations` | Up to 10 U.S. GHCN-Daily IDs. Each ID has 11 uppercase letters or digits and starts with `US`. |
| `stationSearch` | `state`, `bbox`, or both. The Actor fetches observations for up to 10 matches. |
| `startDate`, `endDate` | Inclusive calendar dates in `YYYY-MM-DD` format. Each observation request covers up to 366 days. |
| `dataTypes` | Defaults to `TMAX`, `TMIN`, `PRCP`, `SNOW`, `SNWD`, and `AWND`. Also supports `TAVG`, `ADPT`, `ASLP`, `ASTP`, `WDF2`, `WDF5`, `WSF2`, and `WSF5`. |
| `units` | `metric` (default) or `standard` (U.S. customary). The Actor preserves the numeric values in NOAA's requested unit system. |

Find GHCN-Daily IDs using the GHCND identifier in NOAA's station directory. Observation availability follows the dates returned by NOAA. [NOAA Find a Station](https://www.ncei.noaa.gov/access/search/find-a-station/)

The Actor splits longer observation requests into sequential windows. It waits at least 2.2 seconds between requests, retries transient failures up to three times, and honors `Retry-After`. [NOAA Access Data Service](https://www.ncei.noaa.gov/access/search/documentation/data-service/)

## Dataset

```json
{
  "station": "USW00094728",
  "name": "NY CITY CENTRAL PARK, NY US",
  "date": "2026-10-02",
  "units": "metric",
  "values": { "TMAX": 28.3, "PRCP": 0, "SNOW": null },
  "attributes": {
    "TMAX": { "measurementFlag": null, "qualityFlag": null, "sourceFlag": "1" },
    "PRCP": { "measurementFlag": "T", "qualityFlag": null, "sourceFlag": "1" },
    "SNOW": { "measurementFlag": null, "qualityFlag": null, "sourceFlag": "N", "excludedBySource": true }
  },
  "source": "NOAA National Centers for Environmental Information (NCEI), GHCN-Daily (https://doi.org/10.7289/V5D21VHZ)"
}
```

- `date` is NOAA's published observation date. `name` is `null` if NOAA omits it.
- Each requested type has a key in `values` and `attributes`. Missing observations, quality failures, and measurement flag `P` (missing presumed zero) have a `null` value. Observations withheld by the source filter also have a `null` value, with `attributes[element].excludedBySource` set to `true`. Published flags are retained when available, and missing attributes are `null`.
- `T` is NOAA's trace measurement flag. If NOAA reports a numeric zero with `T`, the Actor preserves both so you can distinguish it from a zero with no trace flag. [GHCN-Daily flag definitions](https://www.ncei.noaa.gov/pub/data/ghcn/daily/readme.txt)
- A station-day is emitted when it has attributes for at least one requested element, including days on which all observations were withheld by the source filter. If there are no station-days to emit, the Actor logs a warning.

## Data source and terms

The source is NOAA National Centers for Environmental Information (NCEI), Global Historical Climatology Network Daily (GHCN-Daily), accessed through the Daily Summaries API. The NOAA Daily Weather History Actor filters observations and converts the response to structured JSON. The Actor is independently maintained and has no affiliation with NOAA. [GHCN-Daily dataset and citation](https://doi.org/10.7289/V5D21VHZ)

The Actor applies the U.S. federal program filter to each observation, including snowfall and snow depth. GHCN-Daily section III defines the allowed source flags below. [GHCN-Daily readme](https://www.ncei.noaa.gov/pub/data/ghcn/daily/readme.txt)

| Source flags | Program or feed |
| --- | --- |
| `0`, `6`, `7`, `K` | NWS Cooperative Observer Program (COOP) summaries, including digitized and WxCoder3 records |
| `1`, `D`, `d` | NWS CF6 summaries and Daily Summary Messages, including feeds delivered through the High Plains Regional Climate Center |
| `A`, `B`, `M`, `W` | U.S. ASOS records and WBAN/ASOS summaries, including the monthly METAR extract |
| `F`, `X` | Historical U.S. Fort and U.S. First-Order observations |
| `R`, `T` | NCEI climate reference networks and USDA NRCS SNOTEL |

COOP is an NWS program whose observers can be volunteers. A source flag identifies the program or feed that supplied the observation. The Actor withholds CoCoRaHS (`N`), RAWS through the Western Regional Climate Center (`U`), global or mixed feeds (`2`, `G`, `H`, `S`), and other sources whose flag does not identify a U.S. federal program or feed, including Datzilla replacements (`Z`). [NCEI GHCN-Daily overview](https://www.ncei.noaa.gov/products/land-based-station/global-historical-climatology-network-daily), [NCEI Open Data Policy](https://www.ncei.noaa.gov/sites/default/files/2023-12/NCEI%20PD-10-2-02%20-%20Open%20Data%20Policy%20Signed.pdf), [GHCN-Daily terms](https://www.ncei.noaa.gov/pub/data/cdo/documentation/GHCND_documentation.pdf)

## Local development

Install dependencies with `npm ci` on Node.js 22 and run `npm test`. The tests use local response fixtures and make no network requests. Run the Actor locally with `apify run --input-file input.json`, using one of the input examples above.

## 日本語概要

NOAA NCEI の公開 API から米国の日次気象履歴を取得します。`US` で始まる観測所 ID、または州・座標範囲と期間を指定できます。観測所は最大10か所で、1回の観測値リクエストは最大366日です。観測日は NOAA の公表どおりに出力し、微量降水は `T` フラグで識別できます。欠測や除外した値は `null` になり、提供元による除外は `excludedBySource` で確認できます。
