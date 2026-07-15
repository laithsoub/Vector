# Vector — Install Guide (Team)

Two quick steps. ~5 minutes, once per PC.

## 1. Install the app
- Double-click **`Vector_1.0.0_x64-setup.exe`**.
- If Windows SmartScreen warns, click **More info → Run anyway** (internal app, unsigned).
- The installer auto-adds WebView2 if your PC doesn't have it (needs internet the first time). Windows 11 already has it.

## 2. Install the automation engine (one time)
- Double-click **`install-python-deps.bat`**.
- It installs Python (if missing) and the required libraries.
- If it says *"Python installed — run again"*, just double-click it a second time.

## 3. Launch Vector
- Open **Vector** from the Start menu.
- Click **Connect to JOE** (top bar) while on the Eaton network or VPN.

---

### Notes
- **Outlook features** need classic Outlook installed (the setup script installs `pywin32` for this).
- **Feedback**: use the **Feedback** button in the top bar anytime — it reaches the Vector team.
- **Coming soon**: AI Assistant and Schematics are locked for now.
- Trouble? Quit fully via the tray icon (**Quit Vector**), relaunch, or message the Vector team.
