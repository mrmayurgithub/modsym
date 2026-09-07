const MAX_CHAIN_ITEMS = 20;
const MAX_TEXT_CHARS = 600;
const MAX_CANDIDATES = 10;
const MAX_CANDIDATE_TEXT = 200;

/**
 * Map the internal resolution result to the stable public JSON contract.
 *
 * - `resolved`: full declaration record.
 * - `ambiguous`: bounded candidate list (bare symbol exists in several
 *   subpath modules; the caller must qualify or inspect).
 * - `not_resolved`: machine-readable `reason`, never a guess.
 *
 * All text is hard-bounded; total output stays around ~1 KB in ordinary
 * cases and never exceeds roughly ~10 KB by construction.
 */
export function serialize(internal, identity) {
  const { name, version, symbol } = identity;
  if (internal.status === 'resolved') {
    return {
      status: 'resolved',
      package: name,
      version,
      symbol,
      declaration: boundDeclaration(internal.decl),
      resolutionChain: boundChain(internal.decl.chain),
      method: internal.method,
      filesVisited: internal.filesVisited ?? 0,
    };
  }
  if (internal.status === 'ambiguous') {
    return {
      status: 'ambiguous',
      package: name,
      version,
      symbol,
      reason: 'ambiguous',
      candidates: (internal.candidates || []).slice(0, MAX_CANDIDATES).map(boundCandidate),
      filesVisited: internal.filesVisited ?? 0,
    };
  }
  const out = {
    status: 'not_resolved',
    package: name,
    version,
    symbol,
    reason: internal.reason || 'not_found',
  };
  if (internal.external) out.external = internal.external.src ?? internal.external;
  if (internal.note) out.note = internal.note;
  return out;
}

function boundDeclaration(decl) {
  return {
    file: decl.file,
    line: decl.line,
    kind: decl.kind,
    overloads: decl.overloads ?? 1,
    text: slice(decl.text, MAX_TEXT_CHARS),
    condition: decl.condition ?? null,
    flavor: decl.flavor ?? null,
  };
}

function boundCandidate(candidate) {
  return {
    file: candidate.file,
    line: candidate.line,
    kind: candidate.kind,
    text: slice(candidate.text, MAX_CANDIDATE_TEXT),
    chain: boundChain(candidate.chain),
    condition: candidate.condition ?? null,
    flavor: candidate.flavor ?? null,
  };
}

function boundChain(chain) {
  if (!Array.isArray(chain)) return [];
  return chain.slice(0, MAX_CHAIN_ITEMS).map(String);
}

function slice(text, max) {
  const str = String(text ?? '');
  return str.length > max ? str.slice(0, max) : str;
}
