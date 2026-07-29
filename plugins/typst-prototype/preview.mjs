const MAIN_FILE = '/main.typ';
const DIAGNOSTICS_JSON = 2;

let typstRuntimePromise = null;
let currentSession = null;

function requireArtifact(artifacts, id) {
  const artifact = artifacts?.[id];
  if (!artifact) {
    throw new Error(`Missing Typst artifact '${id}'.`);
  }
  return artifact;
}

async function loadTypstRuntime(ctx) {
  if (typstRuntimePromise) return typstRuntimePromise;
  typstRuntimePromise = (async () => {
    const artifacts = ctx?.artifacts ?? {};
    const compilerJs = requireArtifact(artifacts, 'typst-web-compiler-js');
    const compilerWasm = requireArtifact(artifacts, 'typst-web-compiler-wasm');
    const rendererJs = requireArtifact(artifacts, 'typst-renderer-js');
    const rendererWasm = requireArtifact(artifacts, 'typst-renderer-wasm');

    const [compilerModule, rendererModule] = await Promise.all([
      import(compilerJs.url),
      import(rendererJs.url)
    ]);

    await compilerModule.default({ module_or_path: compilerWasm.bytes });
    await rendererModule.default({ module_or_path: rendererWasm.bytes });

    const compilerBuilder = new compilerModule.TypstCompilerBuilder();
    compilerBuilder.set_dummy_access_model();
    const compiler = await compilerBuilder.build();

    const rendererBuilder = new rendererModule.TypstRendererBuilder();
    const renderer = await rendererBuilder.build();

    return { compiler, renderer };
  })();
  return typstRuntimePromise;
}

function normalizeDiagnostics(diagnostics) {
  if (!Array.isArray(diagnostics)) return [];
  return diagnostics
    .map((diagnostic) =>
      typeof diagnostic === 'string' ? diagnostic : String(diagnostic)
    )
    .filter(Boolean)
    .map((message) => ({
      severity: message.includes('error:') ? 'error' : 'warning',
      message
    }));
}

function compileVector(compiler, body) {
  compiler.reset();
  compiler.add_source(MAIN_FILE, body);
  const output = compiler.compile(MAIN_FILE, null, 'vector', DIAGNOSTICS_JSON);
  if (output?.hasError) {
    return {
      artifact: null,
      diagnostics: normalizeDiagnostics(output.diagnostics)
    };
  }
  if (!(output?.result instanceof Uint8Array)) {
    throw new Error('Typst compiler returned an unsupported artifact.');
  }
  return { artifact: output.result, diagnostics: [] };
}

function releaseSession(session) {
  if (session && typeof session.free === 'function') {
    session.free();
  }
}

function renderSvg(renderer, artifact) {
  releaseSession(currentSession);
  currentSession = renderer.session_from_artifact(artifact, 'vector');
  return renderer.svg_data(currentSession);
}

export async function render(input, ctx) {
  const body = input?.body ?? '';
  const { compiler, renderer } = await loadTypstRuntime(ctx);
  const compiled = compileVector(compiler, body);

  if (!compiled.artifact) {
    return {
      preview: { mime: 'text/html', text: '' },
      diagnostics: compiled.diagnostics
    };
  }

  return {
    preview: {
      mime: 'text/html',
      text: `<style>
html,body{margin:0;background:#f8fafc;color:#111827}
#plugin-preview-root{box-sizing:border-box;min-height:100%;padding:24px;overflow:auto}
.typst-page{display:flex;justify-content:center}
.typst-page svg{max-width:100%;height:auto;box-shadow:0 1px 4px rgba(15,23,42,.12)}
</style><div class="typst-page">${renderSvg(renderer, compiled.artifact)}</div>`
    },
    diagnostics: compiled.diagnostics
  };
}
