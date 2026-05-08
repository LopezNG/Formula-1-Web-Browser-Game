import "./style.css";
import RAPIER from "@dimforge/rapier3d-compat";
import { Game } from "./game/Game";

async function bootstrap() {
  // Rapier ships its physics engine as WebAssembly. The compat build inlines it,
  // but it must still be initialized asynchronously before any physics types are used.
  await RAPIER.init();

  const canvas = document.getElementById("game-canvas") as HTMLCanvasElement;
  const uiRoot = document.getElementById("ui-root") as HTMLDivElement;
  const loading = document.getElementById("loading") as HTMLDivElement;

  const game = new Game(canvas, uiRoot);
  game.start();

  // Fade out loading overlay once the first frame has been drawn.
  requestAnimationFrame(() => {
    loading.classList.add("hidden");
    setTimeout(() => loading.remove(), 500);
  });

  // Make sure the renderer adapts when the browser window changes size.
  window.addEventListener("resize", () => game.onResize());
}

bootstrap().catch((err) => {
  console.error(err);
  const loading = document.getElementById("loading");
  if (loading) {
    loading.innerHTML = `<div class="loading-inner"><div class="loading-title" style="color:#ff5577">ERROR</div><div class="loading-sub">${String(
      err
    )}</div></div>`;
  }
});
