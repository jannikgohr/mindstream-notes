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
  /** Draw only the first this many nodes and link ends: a growing graph. */
  nodes: number;
  linkEnds: number;
  /**
   * Draw one link in this many, for a device the links are too many for:
   * `linkEvery` of those with both ends on screen, `leavingEvery` of those
   * with one, `throughEvery` of those that only cross it. 1 draws them all.
   * The links kept at 4 are kept at 1 too.
   */
  linkEvery: number;
  leavingEvery: number;
  throughEvery: number;
  /** PALETTE_SIZE colours, four floats each; the last is the accent. */
  palette: Float32Array;
  link: Rgba;
  /** The lit links in runs, each a count of link ends and its colour. */
  litLinks: { ends: number; colour: Rgba }[];
  /** Some nodes are lit: the rest are drawn faint, under them. */
  dimOthers: boolean;
}

export interface GraphRenderer {
  setScene(scene: GraphScene): void;
  setStyles(styles: Uint8Array): void;
  setPositions(x: Float32Array, y: Float32Array): void;
  /** The links drawn again on top, in the colours of `litLinks`. */
  setLitLinks(links: Uint32Array): void;
  draw(frame: GraphFrame): void;
  destroy(): void;
}

// A link is an instance holding its two node indexes, and reads where they
// are from a texture. Knowing both ends, it can leave itself out: see
// `linkEvery`, `leavingEvery` and `throughEvery`.
const LINK_VERTEX = `#version 300 es
in uvec2 a_ends;
uniform highp sampler2D u_positions;
uniform vec4 u_view;
uniform int u_every;
uniform int u_leaving;
uniform int u_through;
vec2 place(uint node) {
  int wide = textureSize(u_positions, 0).x;
  vec2 world = texelFetch(u_positions, ivec2(int(node) % wide, int(node) / wide), 0).xy;
  return world * u_view.xy + u_view.zw;
}
void main() {
  vec2 a = place(a_ends.x);
  vec2 b = place(a_ends.y);
  int seen = int(all(lessThan(abs(a), vec2(1.0)))) + int(all(lessThan(abs(b), vec2(1.0))));
  int every = seen == 2 ? u_every : seen == 1 ? u_leaving : u_through;
  bool kept = gl_InstanceID % every == 0;
  gl_Position = kept
    ? vec4(gl_VertexID == 0 ? a : b, 0.0, 1.0)
    : vec4(2.0, 2.0, 2.0, 1.0);
}`;

// The few links lit on top, by index into the nodes' positions.
const LIT_VERTEX = `#version 300 es
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
  let litProgram: WebGLProgram;
  let nodeProgram: WebGLProgram;
  try {
    linkProgram = program(LINK_VERTEX, LINK_FRAGMENT);
    litProgram = program(LIT_VERTEX, LINK_FRAGMENT);
    nodeProgram = program(NODE_VERTEX, NODE_FRAGMENT);
  } catch (error) {
    console.error('[graph]', error);
    return null;
  }
  const uniform = (p: WebGLProgram, name: string) =>
    gl.getUniformLocation(p, name);
  const linkUniforms = {
    view: uniform(linkProgram, 'u_view'),
    colour: uniform(linkProgram, 'u_colour'),
    positions: uniform(linkProgram, 'u_positions'),
    every: uniform(linkProgram, 'u_every'),
    leaving: uniform(linkProgram, 'u_leaving'),
    through: uniform(linkProgram, 'u_through')
  };
  const litUniforms = {
    view: uniform(litProgram, 'u_view'),
    colour: uniform(litProgram, 'u_colour')
  };
  const nodeUniforms = {
    view: uniform(nodeProgram, 'u_view'),
    pixel: uniform(nodeProgram, 'u_pixel'),
    scale: uniform(nodeProgram, 'u_scale'),
    pass: uniform(nodeProgram, 'u_pass'),
    palette: uniform(nodeProgram, 'u_palette')
  };

  const positions = gl.createBuffer();
  const linkEnds = gl.createBuffer();
  const litIndex = gl.createBuffer();
  // The nodes' positions again, as a texture the links read: as many texels
  // as nodes, in rows of TEXTURE_WIDE.
  const TEXTURE_WIDE = 1024;
  const positionTexture = gl.createTexture();
  gl.bindTexture(gl.TEXTURE_2D, positionTexture);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MIN_FILTER, gl.NEAREST);
  gl.texParameteri(gl.TEXTURE_2D, gl.TEXTURE_MAG_FILTER, gl.NEAREST);
  const corners = gl.createBuffer();
  const radii = gl.createBuffer();
  const styleBuffer = gl.createBuffer();

  const linkArray = gl.createVertexArray();
  gl.bindVertexArray(linkArray);
  gl.bindBuffer(gl.ARRAY_BUFFER, linkEnds);
  const ends = gl.getAttribLocation(linkProgram, 'a_ends');
  gl.enableVertexAttribArray(ends);
  gl.vertexAttribIPointer(ends, 2, gl.UNSIGNED_INT, 0, 0);
  gl.vertexAttribDivisor(ends, 1);

  const litArray = gl.createVertexArray();
  gl.bindVertexArray(litArray);
  gl.bindBuffer(gl.ARRAY_BUFFER, positions);
  const litPos = gl.getAttribLocation(litProgram, 'a_pos');
  gl.enableVertexAttribArray(litPos);
  gl.vertexAttribPointer(litPos, 2, gl.FLOAT, false, 0, 0);

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
  let rows = 1;

  return {
    setScene(scene) {
      nodes = scene.radius.length;
      linkCount = scene.links.length;
      litCount = 0;
      rows = Math.max(1, Math.ceil(nodes / TEXTURE_WIDE));
      packed = new Float32Array(TEXTURE_WIDE * rows * 2);
      gl.bindVertexArray(null);
      gl.bindBuffer(gl.ARRAY_BUFFER, positions);
      gl.bufferData(gl.ARRAY_BUFFER, nodes * 8, gl.DYNAMIC_DRAW);
      gl.bindTexture(gl.TEXTURE_2D, positionTexture);
      gl.texImage2D(
        gl.TEXTURE_2D,
        0,
        gl.RG32F,
        TEXTURE_WIDE,
        rows,
        0,
        gl.RG,
        gl.FLOAT,
        packed
      );
      gl.bindBuffer(gl.ARRAY_BUFFER, radii);
      gl.bufferData(gl.ARRAY_BUFFER, scene.radius, gl.STATIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, styleBuffer);
      gl.bufferData(gl.ARRAY_BUFFER, scene.styles, gl.DYNAMIC_DRAW);
      gl.bindBuffer(gl.ARRAY_BUFFER, linkEnds);
      gl.bufferData(gl.ARRAY_BUFFER, scene.links, gl.STATIC_DRAW);
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
      gl.bufferSubData(gl.ARRAY_BUFFER, 0, packed, 0, nodes * 2);
      gl.bindTexture(gl.TEXTURE_2D, positionTexture);
      gl.texSubImage2D(
        gl.TEXTURE_2D,
        0,
        0,
        0,
        TEXTURE_WIDE,
        rows,
        gl.RG,
        gl.FLOAT,
        packed
      );
    },
    setLitLinks(links) {
      litCount = links.length;
      gl.bindVertexArray(litArray);
      gl.bindBuffer(gl.ELEMENT_ARRAY_BUFFER, litIndex);
      gl.bufferData(gl.ELEMENT_ARRAY_BUFFER, links, gl.DYNAMIC_DRAW);
      gl.bindVertexArray(null);
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

      if (linkCount) {
        gl.useProgram(linkProgram);
        gl.uniform4fv(linkUniforms.view, view);
        gl.uniform4fv(linkUniforms.colour, frame.link);
        gl.uniform1i(linkUniforms.every, Math.max(1, frame.linkEvery));
        gl.uniform1i(linkUniforms.leaving, Math.max(1, frame.leavingEvery));
        gl.uniform1i(linkUniforms.through, Math.max(1, frame.throughEvery));
        gl.activeTexture(gl.TEXTURE0);
        gl.bindTexture(gl.TEXTURE_2D, positionTexture);
        gl.uniform1i(linkUniforms.positions, 0);
        gl.bindVertexArray(linkArray);
        gl.drawArraysInstanced(
          gl.LINES,
          0,
          2,
          Math.min(linkCount, frame.linkEnds) / 2
        );
      }
      if (litCount) {
        gl.useProgram(litProgram);
        gl.uniform4fv(litUniforms.view, view);
        gl.bindVertexArray(litArray);
        let from = 0;
        for (const run of frame.litLinks) {
          const ends = Math.min(run.ends, litCount - from);
          if (ends <= 0) continue;
          gl.uniform4fv(litUniforms.colour, run.colour);
          gl.drawElements(gl.LINES, ends, gl.UNSIGNED_INT, from * 4);
          from += ends;
        }
      }

      gl.useProgram(nodeProgram);
      gl.uniform4fv(nodeUniforms.view, view);
      gl.uniform2f(nodeUniforms.pixel, 2 / canvas.width, 2 / canvas.height);
      gl.uniform1f(nodeUniforms.scale, frame.k * frame.ratio);
      gl.uniform4fv(nodeUniforms.palette, frame.palette);
      gl.bindVertexArray(nodeArray);
      for (const pass of frame.dimOthers ? [1, 2] : [0]) {
        gl.uniform1i(nodeUniforms.pass, pass);
        gl.drawArraysInstanced(
          gl.TRIANGLE_STRIP,
          0,
          4,
          Math.min(nodes, frame.nodes)
        );
      }
      gl.bindVertexArray(null);
    },
    destroy() {
      // A page gets only so many WebGL contexts; give this one back now.
      gl.getExtension('WEBGL_lose_context')?.loseContext();
    }
  };
}
