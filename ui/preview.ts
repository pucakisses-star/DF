/**
 * The 3D model preview panel, powered by mdx-m3-viewer's WebGL viewer (the
 * same library whose parsers drive the porting pipeline).
 *
 * Files resolve through IPC: first from the clicked object's source (map
 * archive or folder), then from Hive Workshop's game-data CDN for stock
 * Blizzard textures. Failures degrade to untextured rendering.
 */
import ModelViewer from 'mdx-m3-viewer/dist/cjs/viewer/viewer';
import mdxHandler from 'mdx-m3-viewer/dist/cjs/viewer/handlers/mdx/handler';
import blpHandler from 'mdx-m3-viewer/dist/cjs/viewer/handlers/blp/handler';
import ddsHandler from 'mdx-m3-viewer/dist/cjs/viewer/handlers/dds/handler';
import tgaHandler from 'mdx-m3-viewer/dist/cjs/viewer/handlers/tga/handler';
import type Scene from 'mdx-m3-viewer/dist/cjs/viewer/scene';
import type MdxModel from 'mdx-m3-viewer/dist/cjs/viewer/handlers/mdx/model';
import type MdxModelInstance from 'mdx-m3-viewer/dist/cjs/viewer/handlers/mdx/modelinstance';
import { vec3 } from 'gl-matrix';

export interface PreviewSourceRef {
  kind: 'map' | 'folder';
  path: string;
}

type FileFetcher = (source: PreviewSourceRef | null, filePath: string) => Promise<Uint8Array | null>;

export class PreviewPanel {
  private viewer: ModelViewer | null = null;
  private scene: Scene | null = null;
  private instance: MdxModelInstance | null = null;
  private currentSource: PreviewSourceRef | null = null;
  private loadToken = 0;
  private yaw = Math.PI * 1.25;
  private pitch = 0.35;
  private distance = 400;
  private targetZ = 60;
  private canvas: HTMLCanvasElement;
  private status: HTMLElement;
  private sequenceSelect: HTMLSelectElement;

  constructor(
    canvas: HTMLCanvasElement,
    status: HTMLElement,
    sequenceSelect: HTMLSelectElement,
    private fetchFile: FileFetcher,
  ) {
    this.canvas = canvas;
    this.status = status;
    this.sequenceSelect = sequenceSelect;
    this.sequenceSelect.addEventListener('change', () => {
      if (this.instance) {
        this.instance.setSequence(Number(this.sequenceSelect.value));
      }
    });
    this.bindOrbitControls();
  }

  private setStatus(text: string): void {
    this.status.textContent = text;
  }

  private ensureViewer(): boolean {
    if (this.viewer) {
      return true;
    }
    try {
      const viewer = new ModelViewer(this.canvas);
      viewer.on('error', () => {
        // Individual resource failures (usually stock textures while offline)
        // are tolerated; the model still renders.
      });
      viewer.addHandler(blpHandler);
      viewer.addHandler(ddsHandler);
      viewer.addHandler(tgaHandler);
      // The handler-level solver serves team colors/glows; those are stock
      // game files, so they resolve via the Hive fallback (source = null).
      viewer.addHandler(mdxHandler, (src: unknown) => this.fetchFile(null, String(src)), false);
      this.scene = viewer.addScene();
      this.viewer = viewer;

      const step = (): void => {
        requestAnimationFrame(step);
        if (this.viewer) {
          this.updateCamera();
          this.viewer.updateAndRender();
        }
      };
      requestAnimationFrame(step);
      return true;
    } catch (e) {
      this.setStatus(`3D preview unavailable: ${(e as Error).message}`);
      this.viewer = null;
      return false;
    }
  }

  private updateCamera(): void {
    if (!this.scene) {
      return;
    }
    const camera = this.scene.camera;
    camera.perspective(Math.PI / 4, this.canvas.width / this.canvas.height, 8, 200000);
    const cp = Math.cos(this.pitch);
    const target = vec3.fromValues(0, 0, this.targetZ);
    const eye = vec3.fromValues(
      target[0] + this.distance * cp * Math.cos(this.yaw),
      target[1] + this.distance * cp * Math.sin(this.yaw),
      target[2] + this.distance * Math.sin(this.pitch),
    );
    camera.moveToAndFace(eye, target, vec3.fromValues(0, 0, 1));
  }

  private bindOrbitControls(): void {
    let dragging = false;
    let lastX = 0;
    let lastY = 0;
    this.canvas.addEventListener('mousedown', (e) => {
      dragging = true;
      lastX = e.clientX;
      lastY = e.clientY;
    });
    window.addEventListener('mouseup', () => (dragging = false));
    window.addEventListener('mousemove', (e) => {
      if (!dragging) {
        return;
      }
      this.yaw -= (e.clientX - lastX) * 0.01;
      this.pitch = Math.min(1.4, Math.max(-0.5, this.pitch + (e.clientY - lastY) * 0.01));
      lastX = e.clientX;
      lastY = e.clientY;
    });
    this.canvas.addEventListener('wheel', (e) => {
      e.preventDefault();
      this.distance = Math.min(20000, Math.max(30, this.distance * (e.deltaY > 0 ? 1.15 : 0.87)));
    });
  }

  clear(message: string): void {
    this.loadToken++;
    if (this.instance) {
      this.instance.detach();
      this.instance = null;
    }
    this.sequenceSelect.innerHTML = '';
    this.sequenceSelect.style.display = 'none';
    this.setStatus(message);
  }

  async show(source: PreviewSourceRef, modelPath: string | undefined, label: string): Promise<void> {
    if (!modelPath) {
      this.clear(`${label}: uses a standard game model (no custom model to preview).`);
      return;
    }
    if (/\.mdl$/i.test(modelPath)) {
      this.clear(`${label}: .mdl (text) models cannot be previewed yet.`);
      return;
    }
    if (!this.ensureViewer()) {
      return;
    }

    const token = ++this.loadToken;
    this.currentSource = source;
    this.setStatus(`Loading ${modelPath}…`);

    const solver = (src: unknown): Promise<Uint8Array | null> => this.fetchFile(this.currentSource, String(src));

    let model: MdxModel | undefined;
    try {
      model = (await this.viewer!.load(modelPath, solver)) as MdxModel | undefined;
    } catch (e) {
      model = undefined;
      if (token === this.loadToken) {
        this.clear(`Could not load model: ${(e as Error).message}`);
      }
      return;
    }
    if (token !== this.loadToken) {
      return; // A newer selection superseded this load.
    }
    if (!model || typeof (model as { addInstance?: unknown }).addInstance !== 'function') {
      this.clear(`Could not load ${modelPath} (unsupported or missing).`);
      return;
    }

    if (this.instance) {
      this.instance.detach();
    }
    const instance = model.addInstance() as MdxModelInstance;
    instance.setScene(this.scene!);
    instance.sequenceLoopMode = 2;

    const sequences = model.sequences ?? [];
    this.sequenceSelect.innerHTML = '';
    if (sequences.length > 0) {
      for (let i = 0; i < sequences.length; i++) {
        const option = document.createElement('option');
        option.value = String(i);
        option.textContent = sequences[i].name;
        this.sequenceSelect.appendChild(option);
      }
      const stand = sequences.findIndex((s: { name: string }) => /stand/i.test(s.name));
      const start = stand >= 0 ? stand : 0;
      this.sequenceSelect.value = String(start);
      instance.setSequence(start);
      this.sequenceSelect.style.display = '';
    } else {
      this.sequenceSelect.style.display = 'none';
    }

    // Frame the camera on the model's bounds.
    const bounds = model.bounds;
    const radius = bounds && bounds.r > 0 ? bounds.r : 100;
    this.distance = radius * 2.8;
    this.targetZ = (bounds ? bounds.z : 0) + radius * 0.5;

    this.instance = instance;
    this.setStatus(`${label} — drag to rotate, scroll to zoom.`);
  }
}
