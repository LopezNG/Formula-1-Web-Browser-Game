# Formula 1 Web Browser Game

A browser-based Formula 1 driving game built with Vite, TypeScript, Three.js, and Rapier physics.

## Requirements

- Node.js 18 or newer
- npm

## Run Locally

From this project folder:

```bash
npm install
npm run dev
```

Vite will print a local URL, usually:

```text
http://localhost:5173/
```

Open that URL in your browser to play.

If dependencies are already installed, you can skip `npm install` and just run:

```bash
npm run dev
```

## Controls

- `W` or `Up Arrow`: throttle
- `S` or `Down Arrow`: brake / reverse
- `A` / `D` or `Left Arrow` / `Right Arrow`: steer
- `Space`: handbrake
- `Shift`: DRS boost
- `R`: reset to track

## Production Build

Create a production build:

```bash
npm run build
```

Preview the production build locally:

```bash
npm run preview
```

Vite will print the preview URL in the terminal.

## Troubleshooting

If `npm run dev` is not recognized, make sure you are in the project folder:

```bash
cd "/c/Users/Neoron/Downloads/Formula 1 Web Browser Game"
```

If the app fails after moving the folder or deleting dependencies, reinstall packages:

```bash
npm install
```

If the default Vite port is busy, Vite will automatically choose another port and show the new URL in the terminal.
