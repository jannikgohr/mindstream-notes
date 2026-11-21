/**
 * Draws a schema view's `graph` with WebGL: every link in one call and every
 * node in another, straight from one buffer of positions. Moving the camera
 * uploads nothing, and a layout tick uploads only the positions. A 2D canvas
 * builds and strokes each link in JavaScript every frame, which takes
 * seconds a frame on a graph with hundreds of thousands of links.
 *
 * Labels stay on a 2D canvas above this one (see SchemaGraph.svelte).
 */

/** Per node, in `styles[2 * i + 1]`. */
export const NODE_RING = 1;
export const NODE_LIT = 2;
export const NODE_ACCENT = 4;
/** Colours in a palette; `styles[2 * i]` picks one. */
export const PALETTE_SIZE = 10;

export type Rgba = [number, number, number, number];

const parsed = new Map<string, Rgba>();
let scratch: CanvasRenderingContext2D | null | undefined;

/**
 * A theme colour as numbers. Themes write colours in any CSS notation, and a
 * canvas is what turns one into red, green and blue.
 */
export function rgba(css: string, alpha = 1): Rgba {
  let colour = parsed.get(css);
  if (!colour) {
    scratch ??= document
      .createElement('canvas')
      .getContext('2d', { willReadFrequently: true });
    colour = [0, 0, 0, 1];
    if (scratch) {
      scratch.clearRect(0, 0, 1, 1);
      scratch.fillStyle = '#000';
      scratch.fillStyle = css;
      scratch.fillRect(0, 0, 1, 1);
      const [r, g, b, a] = scratch.getImageData(0, 0, 1, 1).data;
      colour = [r / 255, g / 255, b / 255, a / 255];
    }
    parsed.set(css, colour);
  }
  return [colour[0], colour[1], colour[2], colour[3] * alpha];
}

export interface GraphScene {
  /** Index pairs. */
  links: Uint32Array;
  radius: Float32Array;
  /** Two bytes per node: a palette index and the NODE_ flags. */
  styles: Uint8Array;
}

export interface GraphFrame {
  /** The canvas in CSS pixels and its device pixels per CSS pixel. */
  width: number;
  height: number;
  ratio: number;
  /** A world point is at `width / 2 + x + world.x * k` on screen. */
  x: number;
  y: number;
  k: number;
  /** PALETTE_SIZE colours, four floats each; the last is the accent. */
  palette: Float32Array;
  link: Rgba;
  litLink: Rgba;
  /** Some nodes are lit: the rest are drawn faint, under them. */
  dimOthers: boolean;
}

export interface GraphRenderer {
  setScene(scene: GraphScene): void;
  setStyles(styles: Uint8Array): void;
  setPositions(x: Float32Array, y: Float32Array): void;
  /** The links drawn again on top, in `litLink`. */
  setLitLinks(links: Uint32Array): void;
  draw(frame: GraphFrame): void;
  destroy(): void;
}

const LINK_VERTEX = `#version 300 es
in vec2 a_pos;
uniform vec4 u_view;
void main() {
  gl_Position = vec4(a_pos * u_view.xy + u_view.zw, 0.0, 1.0);
}`;

const LINK_FRAGMENT = `#version 300 es
precision mediump float;
uniform vec4 u_colour;
out vec4 colour;
void main() {
  colour = vec4(u_colour.rgb * u_colour.a, u_colour.a);
}`;

// A node is a square around its centre; the fragment shader cuts the disc or
// ring out of it. u_pass: 0 draws every node, 1 the unlit ones faintly, 2 the
// lit ones.
const NODE_VERTEX = `#version 300 es
in vec2 a_corner;
in vec2 a_centre;
in float a_radius;
in uvec2 a_style;
uniform vec4 u_view;
uniform vec2 u_pixel;
uniform float u_scale;
uniform int u_pass;
uniform vec4 u_palette[${PALETTE_SIZE}];
out vec2 v_offset;
out vec4 v_colour;
out float v_outer;
out float v_inner;
void main() {
  bool accent = (a_style.y & ${NODE_ACCENT}u) != 0u;
  bool lit = accent || (a_style.y & ${NODE_LIT}u) != 0u;
  bool ring = !accent && (a_style.y & ${NODE_RING}u) != 0u;
  // Never under a pixel across, so a far-off graph is still a cloud of dots.
  v_outer = max(a_radius * u_scale, 1.0);
  v_inner = ring ? max(a_radius - 2.0, 0.0) * u_scale : -1.0;
  v_offset = a_corner * (v_outer + 1.0);
  v_colour = accent ? u_palette[${PALETTE_SIZE - 1}] : u_palette[a_style.x];
  if (u_pass == 1) v_colour.a *= 0.25;
  bool hidden = (u_pass == 1 && lit) || (u_pass == 2 && !lit);
  vec2 centre = a_centre * u_view.xy + u_view.zw;
  gl_Position = hidden
    ? vec4(2.0, 2.0, 2.0, 1.0)
    : vec4(centre + v_offset * u_pixel, 0.0, 1.0);
}`;

const NODE_FRAGMENT = `#version 300 es
precision mediump float;
in vec2 v_offset;
in vec4 v_colour;
in float v_outer;
in float v_inner;
out vec4 colour;
void main() {
  float d = length(v_offset);
  float cover = clamp(v_outer - d + 0.5, 0.0, 1.0);
  if (v_inner >= 0.0) cover *= clamp(d - v_inner + 0.5, 0.0, 1.0);
  float alpha = v_colour.a * cover;
  colour = vec4(v_colour.rgb * alpha, alpha);
}`;

/** `null` where the browser has no WebGL2: the caller draws in 2D then. */
export function createGraphRenderer(
  canvas: HTMLCanvasElement
): GraphRenderer | null {
  const gl = canvas.getContext('webgl2', {
    antialias: true,
    premultipliedAlpha: true
  });
  if (!gl) return null;

  function program(vertex: string, fragment: string): WebGLProgram {
    const made = gl!.createProgram()!;
    for (const [type, source] of [
      [gl!.VERTEX_SHADER, vertex],
      [gl!.FRAGMENT_SHADER, fragment]
    ] as const) {
      const shader = gl!.createShader(type)!;
      gl!.shaderSource(shader, source);
      gl!.compileShader(shader);
      gl!.attachShader(made, shader);
    }
    gl!.linkProgram(made);
    if (!gl!.getProgramParameter(made, gl!.LINK_STATUS))
      throw new Error(`Graph shader: ${gl!.getProgramInfoLog(made)}`);
    return made;
  }

  let linkProgram: WebGLProgram;
  let nodeProgram: WebGLProgram;
  try {
    linkProgram = program(LINK_VERTEX, LINK_FRAGMENT);
    nodeProgram = program(NODE_VERTEX, NODE_FRAGMENT);
  } catch (error) {
    console.error('[graph]', error);
    return null;
  }
  const uniform = (p: WebGLProgram, name: string) =>
    gl.getUniformLocation(p, name);
  const linkUniforms = {
    view: uniform(linkProgram, 'u_view'),
    colour: uniform(linkProgram, 'u_colour')
  };
  const nodeUniforms = {
    view: uniform(nodeProgram, 'u_view'),
    pixel: uniform(nodeProgram, 'u_pixel'),
    scale: uniform(nodeProgram, 'u_scale'),
    pass: uniform(nodeProgram, 'u_pass'),
    palette: uniform(nodeProgram, 'u_palette')
  };

  const positions = gl.createBuffer();
  const linkIndex = gl.createBuffer();
  const litIndex = gl.createBuffer();
  const corners = gl.createBuffer();
  const radii = gl.createBuffer();
  const styleBuffer = gl.createBuffer();

  const linkArray = gl.createVertexArray();
  gl.bindVertexArray(linkArray);
  gl.bindBuffer(gl.ARRAY_BUFFER, positions);
  const linkPos = gl.getAttribLocation(linkProgram, 'a_pos');
  gl.enableVertexAttribArray(linkPos);
  gl.vertexAttribPointer(linkPos, 2, gl.FLOAT, false, 0, 0);

  const nodeArray = gl.createVertexArray();
  gl.bindVertexArray(nodeArray);
  const attribute = (name: string) => {
    const location = gl.getAttribLocation(nodeProgram, name);
    gl.enableVertexAttribArray(location);
    return location;
  };
  gl.bindBuffer(gl.ARRAY_BUFFER, corners);
  gl.bufferData(
    gl.ARRAY_BUFFER,
    new Float32Array([-1, -1, 1, -1, -1, 1, 1, 1]),
    gl.STATIC_DRAW
  );
  gl.vertexAttribPointer(attribute('a_corner'), 2, gl.FLOAT, false, 0, 0);
  gl.bindBuffer(gl.ARRAY_BUFFER, positions);
  const centre = attribute('a_centre');
  gl.vertexAttribPointer(centre, 2, gl.FLOAT, false, 0, 0);
  gl.vertexAttribDivisor(centre, 1);
  gl.bindBuffer(gl.ARRAY_BUFFER, radii);
  const radius = attribute('a_radius');
  gl.vertexAttribPointer(radius, 1, gl.FLOAT, false, 0, 0);
  gl.vertexAttribDivisor(radius, 1);
  gl.bindBuffer(gl.ARRAY_BUFFER, styleBuffer);
  const style = attribute('a_style');
  gl.vertexAttribIPointer(style, 2, gl.UNSIGNED_BYTE, 0, 0);
  gl.vertexAttribDivisor(style, 1);
  gl.bindVertexArray(null);

  gl.enable(gl.BLEND);
  gl.blendFunc(gl.ONE, gl.ONE_MINUS_SRC_ALPHA);

  let nodes = 0;
  let linkCount = 0;
  let litCount = 0;
  let packed = new Float32Array(0);

  return {
    setScene(scene) {
      nodes = scene.radius.length;
      linkCount = scene.links.length;
      litCount = 0;
      packed = new Float32Array(nodes * 2);
      gl.bindVertexArray(null);
      gl.bindBuffer(gl.ARRAY_BUFFER, positions);
      gl.bufferData(gl.ARRAY_BUFFER, packed, gl.DYNAMIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, radii);
      gl.bufferData(gl.ARRAY_BUFFER, scene.radius, gl.STATIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, styleBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, scene.styles, gl.DYNAMIC_DRAW);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, linkIndex);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, scene.links, gl.STATIC_DRAW);
    },
    setStyles(styles) {
      gl.bindBuffer(gl.ARRAY_BUFFER, styleBuffer);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, styles);
    },
    setPositions(x, y) {
      for (let i = 0; i < nodes; i++) {
        packed[2 * i] = x[i];
        packed[2 * i + 1] = y[i];
      }
      gl.bindBuffer(gl.ARRAY_BUFFER, positions);
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, packed);
    },
    setLitLinks(links) {
      litCount = links.length;
      gl.bindVertexArray(null);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, litIndex);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, links, gl.DYNAMIC_DRAW);
    },
    draw(frame) {
      gl.viewport(0, 0, canvas.width, canvas.height);
      gl.clearColor(0, 0, 0, 0);
      gl.clear(gl.COLOR_BUFFER_BIT);
      if (!nodes || !frame.width || !frame.height) return;
      const view = [
        (2 * frame.k) / frame.width,
        (-2 * frame.k) / frame.height,
        (2 * frame.x) / frame.width,
        (-2 * frame.y) / frame.height
      ];

      gl.useProgram(linkProgram);
      gl.uniform4fv(linkUniforms.view, view);
      gl.bindVertexArray(linkArray);
      if (linkCount) {
        gl.uniform4fv(linkUniforms.colour, frame.link);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, linkIndex);
        gl.drawElements(gl.LINES, linkCount, gl.UNSIGNED_INT, 0);
      }
      if (litCount) {
        gl.uniform4fv(linkUniforms.colour, frame.litLink);
        gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, litIndex);
        gl.drawElements(gl.LINES, litCount, gl.UNSIGNED_INT, 0);
      }

      gl.useProgram(nodeProgram);
      gl.uniform4fv(nodeUniforms.view, view);
      gl.uniform2f(nodeUniforms.pixel, 2 / canvas.width, 2 / canvas.height);
      gl.uniform1f(nodeUniforms.scale, frame.k * frame.ratio);
      gl.uniform4fv(nodeUniforms.palette, frame.palette);
      gl.bindVertexArray(nodeArray);
      for (const pass of frame.dimOthers ? [1, 2] : [0]) {
        gl.uniform1i(nodeUniforms.pass, pass);
        gl.drawArraysInstanced(gl.TRIANGLE_STRIP, 0, 4, nodes);
      }
      gl.bindVertexArray(null);
    },
    destroy() {
      // A page gets only so many WebGL contexts; give this one back now.
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
  };
}
