# J.A.R.V.I.S. v2

Voice assistant powered by Google Gemini, built as an installable web app (PWA).

## 1. Get a Gemini API key
https://aistudio.google.com/apikey → **Create API key**.
Paste it in the app: **gear icon (top right) → Gemini API key → TEST**.
The key is stored only in that browser. Do not paste it into chats or commit it to GitHub.

## 2a. Run on your computer
Double-click `start.bat` (Windows) or run `python serve.py` → opens http://localhost:8765.
To install as an app: in Chrome/Edge click the **install icon** in the address bar (or menu → *Install J.A.R.V.I.S.*).
You get a desktop / Start menu icon that opens it in its own window. The server (`start.bat`) must be running.

## 2b. Put it on your phone's home screen (needs HTTPS hosting)
The microphone only works over HTTPS, so the app has to be hosted. Free option, GitHub Pages:
1. Create a GitHub account → **New repository** (e.g. `jarvis`), public.
2. **Add file → Upload files** → drag in everything from this folder → Commit.
3. **Settings → Pages → Source: Deploy from a branch → main / root** → Save.
4. After ~1 min it's live at `https://<your-username>.github.io/jarvis/`.
5. On the phone open that link:
   - **Android (Chrome):** menu ⋮ → *Add to Home screen* / *Install app*.
   - **iPhone (Safari):** Share → *Add to Home Screen*.
6. Open the app from the home screen and enter your API key once (each device/browser needs it separately).

## Workshop (build things like Tony Stark)
- "Let's build an Iron Man helmet with LED eyes" → JARVIS designs the project: parts list with RON prices and Romanian shops, tools, wiring, step-by-step build, safety notes, Mark II ideas. Shown in the WORKSHOP panel and saved on the device.
- "Next step" / "Done" → reads the next step. "Repeat", "Previous step", "Step 4", "Parts list", "Tools", "Safety".
- Any question while a project is active is answered in its context ("what resistor do I need?"). Code and wiring appear on screen with a COPY button.
- Camera button (or "look at this", then tap the camera) → send a photo of your build; JARVIS checks it against the current step.
- "List projects", "Switch to <name>", NEW / DEL buttons in the panel.

## Commands
Anything you say goes to Gemini, except these, which are instant:
- "What time is it?", "What's the date?"
- "Weather" (default city: Suceava) / "Weather in London"
- "Set a timer for 10 minutes"
- "Open YouTube", "Play Daft Punk", "Google best pizza near me"
- "News" / "Give me the headlines": Gemini searches Google and briefs you; sources appear in the INTEL panel
- "Stop", "Help", "Forget everything"

**WAKE WORD** = always listening; say "Jarvis, ..." before each command. **Ctrl+Space** = talk, **Esc** = silence.

## Settings
Model (`gemini-flash-latest` by default; **TEST** lists every model your key can use), Google Search grounding on/off,
how JARVIS addresses you, home city, news region, speech language (English / Romanian), voice, speed.
Best British "JARVIS" voices: **Microsoft Ryan / Thomas (Natural)** in Edge, **Google UK English Male** in Chrome, **Daniel** on iPhone/Mac.
