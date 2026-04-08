# Task Canvas

A small, browser-based **task board** where work is laid out on an **infinite canvas** instead of a flat list. You arrange tasks as boxes, connect parent and sub-tasks with lines, and pan or zoom the view like a map.

## What it does

- **Visual hierarchy**: Tasks can have sub-tasks; relationships are drawn as connectors between nodes.
- **Canvas navigation**: Pan and zoom so you can organize large breakdowns without crowding the screen.
- **Inspector**: Select a task to tweak appearance—text alignment, font size, border color, and background.
- **Persistence**: Your layout and tasks are saved in the browser (**localStorage**), so they survive refresh on the same device.
- **Theme**: Toggle **light / dark** from the header.

There is no server or sign-in: open the app locally and everything runs in the browser.

## How to run

Because the app loads scripts from files, use any static file server (or open `index.html` if your environment allows it).

**Option A — Python (if installed):**

```bash
cd task-tracker
python -m http.server 8080
```

Then open `http://localhost:8080` in your browser.

**Option B — Open the file directly**

Double-click `index.html` or open it from your editor’s preview, if file URLs work for your setup.

## Project layout

| File        | Role                                      |
|------------|-------------------------------------------|
| `index.html` | Page structure and UI shell             |
| `styles.css` | Layout, canvas, inspector, themes        |
| `app.js`     | Canvas logic, tasks, storage, inspector   |

## Tech stack

Plain **HTML**, **CSS**, and **JavaScript**—no build step or package manager required.
