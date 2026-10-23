"""One-off discovery run: open an odds site (logging in to AmWager, or a public page with --no-login),
open a track, and record how the site delivers odds.

Writes screenshots, captured JSON/websocket traffic and a sanitized summary to
$DATA_DIR/discovery/, which Totebot shows at /discovery. Credentials come from
AMWAGER_USERNAME / AMWAGER_PASSWORD (environment or /etc/totebot.env) and are
scrubbed from everything written.

    sudo bash deploy/amwager-discover.sh --track Belmont
"""
import argparse
import asyncio
import json
import os
import re
import shutil
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, List, Optional

ENV_FILE = "/etc/totebot.env"
START_URL = "https://pro.amwager.com/"
MAX_BODY = 500_000

ODDS_KEYS = re.compile(
    r'"(odds|liveodds|winodds|morningline|ml|program\w*|saddle\w*|post\w*|mtp|runners?|entries|'
    r'horses?|scratch\w*|pools?|probables?|exacta|win|track\w*|race\w*)"\s*:', re.I)
ODDS_VALUES = re.compile(r'"\d{1,2}[-/]\d{1,2}"')
SECRET_FIELDS = re.compile(
    r'("(?:[\w-]*token[\w-]*|session[\w-]*|auth[\w-]*|password|passwd|pin|ssn|cookie)"\s*:\s*)"[^"]*"', re.I)
JWT = re.compile(r"eyJ[\w-]{8,}\.[\w-]{8,}\.[\w-]{8,}")


def load_env_file(path: str = ENV_FILE) -> None:
    try:
        lines = Path(path).read_text().splitlines()
    except OSError:
        return
    values = {}
    for line in lines:
        line = line.strip()
        if line and not line.startswith("#") and "=" in line:
            k, v = line.split("=", 1)
            values[k.strip()] = v.strip()  # last assignment wins, as with systemd
    for k, v in values.items():
        os.environ.setdefault(k, v)


def credential_report(user: str, pw: str) -> str:
    """Facts about the saved login that help spot typos, without revealing it."""
    def quirks(v: str) -> str:
        notes = []
        if v != v.strip():
            notes.append("has leading/trailing spaces")
        if v[:1] in "'\"" or v[-1:] in "'\"":
            notes.append("starts or ends with a quote character")
        return ", ".join(notes) or "ok"

    masked = (user[:2] + "***" + user[user.find("@"):]) if "@" in user else user[:2] + "***"
    return f"Saved login: user {masked} ({quirks(user)}); password {len(pw)} chars ({quirks(pw)})"


class Scrubber:
    def __init__(self, *secrets: str):
        self.secrets = [s for s in secrets if s and len(s) >= 3]

    def __call__(self, text: str) -> str:
        for s in self.secrets:
            text = text.replace(s, "***")
        text = JWT.sub("<jwt>", text)
        return SECRET_FIELDS.sub(r'\1"***"', text)


def shape(obj: Any, depth: int = 0) -> Any:
    """Compact structural outline of a JSON value."""
    if depth > 5:
        return "…"
    if isinstance(obj, dict):
        items = list(obj.items())
        out = {k: shape(v, depth + 1) for k, v in items[:25]}
        if len(items) > 25:
            out["…"] = f"+{len(items) - 25} keys"
        return out
    if isinstance(obj, list):
        return [shape(obj[0], depth + 1), f"×{len(obj)}"] if obj else []
    if isinstance(obj, str):
        return obj if len(obj) <= 24 else obj[:21] + "…"
    return obj


def score(text: str) -> int:
    return 3 * len(set(m.lower() for m in ODDS_KEYS.findall(text))) + min(len(ODDS_VALUES.findall(text)), 30)


async def first_visible(locator) -> Optional[Any]:
    for i in range(await locator.count()):
        el = locator.nth(i)
        try:
            if await el.is_visible():
                return el
        except Exception:
            pass
    return None


async def find_password(page):
    """(frame, password input) for the first visible password box in the page or any iframe."""
    for frame in page.frames:
        try:
            box = await first_visible(frame.locator("input[type=password]"))
        except Exception:
            continue
        if box is not None:
            return frame, box
    return None, None


async def run(track: str, out: Path, url: Optional[str], watch_s: int, headed: bool, start_url: str = START_URL,
              login_url: Optional[str] = None, login: bool = True) -> None:
    from playwright.async_api import async_playwright

    load_env_file()
    user, pw = os.environ.get("AMWAGER_USERNAME", ""), os.environ.get("AMWAGER_PASSWORD", "")
    if login and (not user or not pw):
        raise SystemExit(f"Set AMWAGER_USERNAME and AMWAGER_PASSWORD in {ENV_FILE}")
    scrub = Scrubber(user, pw)

    if out.exists():
        shutil.rmtree(out)
    out.mkdir(parents=True)
    report: List[str] = []
    records: List[dict] = []
    ws_frames: dict = {}
    pending: List[asyncio.Task] = []

    def say(msg: str) -> None:
        print(msg, flush=True)
        report.append(msg)

    async def on_response(resp) -> None:
        try:
            ctype = resp.headers.get("content-type", "")
            if resp.request.resource_type not in ("xhr", "fetch", "eventsource") and "json" not in ctype:
                return
            body = (await resp.body())[:MAX_BODY].decode("utf-8", "replace")
        except Exception:
            return
        sent = None
        try:
            posted = resp.request.post_data_json
            if isinstance(posted, dict):
                sent = {k: type(v).__name__ for k, v in posted.items()}  # field names only, never values
        except Exception:
            pass
        records.append({
            "t": datetime.now(timezone.utc).isoformat(), "method": resp.request.method,
            "status": resp.status, "url": scrub(resp.url), "ctype": ctype, "body": scrub(body), "sent": sent,
        })

    def on_websocket(ws) -> None:
        url = scrub(ws.url)
        ws_frames.setdefault(url, [])

        def frame(payload) -> None:
            text = payload if isinstance(payload, str) else f"<binary {len(payload)} bytes>"
            ws_frames[url].append(scrub(text[:20_000]))

        ws.on("framereceived", frame)

    async def snap(page, name: str) -> None:
        try:
            await page.screenshot(path=str(out / f"{name}.png"), full_page=False)
        except Exception as e:
            say(f"(screenshot {name} failed: {e})")

    async with async_playwright() as p:
        browser = await p.chromium.launch(headless=not headed, executable_path=os.environ.get("CHROMIUM_PATH") or None)
        ctx = await browser.new_context(
            viewport={"width": 1366, "height": 900},
            user_agent=("Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 "
                        "(KHTML, like Gecko) Chrome/131.0.0.0 Safari/537.36"),
        )
        page = await ctx.new_page()
        page.on("response", lambda r: pending.append(asyncio.create_task(on_response(r))))
        page.on("websocket", on_websocket)

        visible = ""
        try:
            say(f"Discovery {datetime.now(timezone.utc):%Y-%m-%d %H:%M}Z  track={track!r}")
            say(credential_report(user, pw) if login else "No login (public page)")
            try:
                await page.goto(start_url, wait_until="domcontentloaded", timeout=45_000)
            except Exception as e:
                say(f"Could not load {start_url}: {e}")
            await page.wait_for_timeout(5000)
            await snap(page, "1-home")

            say(f"Home page title: {scrub(await page.title())!r}  url: {scrub(page.url)}")
            if login:
                if login_url:
                    try:
                        await page.goto(login_url, wait_until="domcontentloaded", timeout=45_000)
                        await page.wait_for_timeout(4000)
                    except Exception as e:
                        say(f"Could not load {login_url}: {e}")

                # Log in: find a password box in the page or any iframe, opening a login form first if needed.
                frame, pw_box = await find_password(page)
                if pw_box is None:
                    login_re = re.compile(r"^\s*(log\s*in|sign\s*in|login)\s*$", re.I)
                    for candidate in (
                        page.get_by_role("button", name=login_re),
                        page.get_by_role("link", name=login_re),
                        page.get_by_text(login_re),
                        page.locator("[href*=login i], [class*=login i], [id*=login i]"),
                    ):
                        opener = await first_visible(candidate)
                        if opener is None:
                            continue
                        try:
                            await opener.click()
                        except Exception:
                            continue
                        await page.wait_for_timeout(4000)
                        frame, pw_box = await find_password(page)
                        if pw_box is not None:
                            break
                if pw_box is None:
                    await snap(page, "2-no-login-form")
                    say("Login: no password field found (see 1-home.png and 2-no-login-form.png)")
                    say("Frames: " + ", ".join(scrub(f.url)[:120] for f in page.frames))
                else:
                    if frame is not page.main_frame:
                        say(f"Login form is inside an iframe: {scrub(frame.url)[:150]}")
                    user_box = await first_visible(frame.locator(
                        "input[type=email], input[name*=mail i], input[id*=mail i], input[placeholder*=mail i], "
                        "input[name*=user i], input[id*=user i], input[placeholder*=user i], input[autocomplete=username]"))
                    if user_box is None:
                        # Fall back to the last visible text box that comes before the password box.
                        inputs = frame.locator("input:not([type=hidden]):not([type=checkbox]):not([type=radio])")
                        for i in range(await inputs.count()):
                            el = inputs.nth(i)
                            if await el.get_attribute("type") == "password":
                                break
                            if await el.is_visible():
                                user_box = el
                    if user_box is None:
                        say("Login: no username field found")
                    else:
                        await user_box.fill(user)
                        await pw_box.fill(pw)
                        attrs = [f"{a}={await user_box.get_attribute(a)!r}" for a in ("type", "name", "id", "placeholder")]
                        say("Email box used: " + " ".join(attrs))
                        typed_user = await user_box.input_value()
                        typed_pw = await pw_box.input_value()
                        say(f"Typed into form: email {'matches' if typed_user == user else 'DOES NOT match'} saved value; "
                            f"password {'matches' if typed_pw == pw else 'DOES NOT match'} ({len(typed_pw)} chars)")
                        await snap(page, "2-login-filled")
                        await pw_box.press("Enter")
                        await page.wait_for_timeout(4000)
                        if (await find_password(page))[1] is not None:
                            submit = await first_visible(frame.locator("button[type=submit], input[type=submit]"))
                            submit = submit or await first_visible(
                                frame.get_by_role("button", name=re.compile(r"log\s*in|sign\s*in|submit|continue", re.I)))
                            if submit:
                                await submit.click()
                        await page.wait_for_timeout(8000)
                        still = (await find_password(page))[1]
                        say("Login: " + ("password field still visible, may have FAILED (see 3-after-login.png)" if still else "looks OK"))
            await snap(page, "3-after-login")

            # Open the track.
            if url:
                try:
                    await page.goto(url, wait_until="domcontentloaded", timeout=45_000)
                    say(f"Opened {url}")
                except Exception as e:
                    say(f"Could not open {url}: {e}")
            elif track:
                target = await first_visible(page.get_by_text(re.compile(re.escape(track), re.I)))
                if target is None:
                    say(f"Track: no visible text matching {track!r} (see 3-after-login.png)")
                else:
                    try:
                        await target.click()
                        say(f"Track: clicked {scrub((await target.inner_text())[:80])!r}")
                    except Exception as e:
                        say(f"Track: click failed: {e}")
            await page.wait_for_timeout(8000)
            await snap(page, "4-track")
            say(f"Page URL: {scrub(page.url)}")

            say(f"Watching for odds updates for {watch_s}s…")
            await page.wait_for_timeout(watch_s * 1000)
            await snap(page, "5-track-later")
            try:
                visible = scrub(await page.inner_text("body"))
            except Exception:
                visible = ""
        except Exception as e:  # keep whatever was captured so far
            say(f"ERROR during run: {type(e).__name__}: {scrub(str(e))[:500]}")
            await snap(page, "9-error")
        if pending:
            await asyncio.gather(*pending, return_exceptions=True)
        await browser.close()

    # Write outputs.
    with open(out / "network.jsonl", "w") as fh:
        for r in records:
            fh.write(json.dumps(r) + "\n")
    (out / "websockets.json").write_text(json.dumps(ws_frames, indent=1))

    lines = list(report)
    lines += ["", "== Visible text on the track page (first 3000 chars) ==", visible[:3000]]
    ranked = sorted(records, key=lambda r: score(r["body"]), reverse=True)
    lines += ["", f"== Top data responses ({len(records)} captured) =="]
    for r in ranked[:8]:
        lines.append(f"\n[score {score(r['body'])}] {r['method']} {r['status']} {r['url']}  ({len(r['body']) / 1024:.1f} KB)")
        if r.get("sent"):
            lines.append(f"request fields: {r['sent']}")
        try:
            lines.append("shape: " + json.dumps(shape(json.loads(r["body"])))[:1500])
        except ValueError:
            pass
        lines.append("sample: " + r["body"][:2000])
    lines += ["", f"== Websockets ({len(ws_frames)}) =="]
    for wurl, frames in ws_frames.items():
        lines.append(f"\n{wurl}  frames={len(frames)}")
        for f in sorted(frames, key=score, reverse=True)[:3]:
            lines.append("  frame: " + f[:1500])
    lines += ["", "== All captured responses =="]
    lines += [f"{r['method']} {r['status']} {len(r['body']):>8}B {r['url'][:200]}" for r in records]
    (out / "summary.txt").write_text(scrub("\n".join(lines)))
    for f in out.iterdir():
        f.chmod(0o644)
    out.chmod(0o755)
    print(f"\nDone. Open /discovery in Totebot (files in {out}).")


def main() -> None:
    ap = argparse.ArgumentParser(description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    ap.add_argument("--track", default="Belmont", help="text of the track link to click")
    ap.add_argument("--url", help="open this AmWager URL after login instead of clicking the track")
    ap.add_argument("--watch", type=int, default=60, help="seconds to keep recording on the track page")
    ap.add_argument("--start-url", default=START_URL)
    ap.add_argument("--login-url", help="AmWager's login page, if logging in from the home page fails")
    ap.add_argument("--no-login", action="store_true", help="public page: skip logging in")
    ap.add_argument("--headed", action="store_true", help="show the browser (needs a display)")
    ap.add_argument("--out", default=None, help="output dir (default $DATA_DIR/discovery)")
    args = ap.parse_args()
    load_env_file()
    out = Path(args.out or Path(os.environ.get("DATA_DIR", "data")) / "discovery")
    asyncio.run(run(args.track, out, args.url, args.watch, args.headed, args.start_url, args.login_url, not args.no_login))


if __name__ == "__main__":
    main()
