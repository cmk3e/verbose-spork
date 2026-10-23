"""Template adapter for a tote feed whose JSON doesn't match our schema.

Point the config at it with "adapter": "examples.adapter_example" (any
importable module works). Each function receives the feed's parsed JSON and
returns the schema documented in tote_handicapper/providers.py. Delete the
function you don't need; the provider skips missing ones.

The field names below are placeholders for whatever your feed actually sends.
"""


def adapt_races(raw):
    return {"races": [
        {
            "race_id": f"{r['trackCode']}-{r['raceDate']}-{r['raceNumber']}",
            "track": r["trackCode"],
            "race_number": r["raceNumber"],
            "post_time": r["postTimeUtc"],  # ISO-8601 with offset
        }
        for r in raw["data"]["races"]
    ]}


def adapt_tote(raw, race):
    return {
        "race_id": race.race_id if race else raw["raceId"],
        "post_time": raw.get("postTimeUtc"),
        "win_pool": raw.get("pools", {}).get("WIN"),
        "runners": [
            {
                "program_num": e["programNumber"],
                "name": e["horseName"],
                "odds": e["liveOdds"],          # "5-2", "9/5", 7, ...
                "scratched": e.get("scratched", False),
            }
            for e in raw["entries"]
        ],
        "exacta_probables": {
            f"{p['first']}-{p['second']}": p["payout"] for p in raw.get("exactaProbables", [])
        },
        "probables_base": 2,
    }
