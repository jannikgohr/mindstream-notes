/**
 * Stands in for an embed's iframe when the embed policy keeps it from
 * loading (see ./embed-policy). Excalidraw renders it inside the embed's
 * frame, so it moves, scales and activates like the iframe would.
 */

import { openExternalUrl } from '$lib/api/external-url';
import { tUi, tUiFormat } from '$lib/settings/i18n.svelte';
import { embedHost, type EmbedDecision } from './embed-policy';

const MESSAGE_KEYS = {
  blocked: 'freeform.embed.blocked',
  unsupported: 'freeform.embed.unsupported',
  'not-https': 'freeform.embed.notHttps'
} as const;

export interface EmbedPlaceholderProps {
  link: string;
  decision: Exclude<EmbedDecision, 'load'>;
  onAllowHost: (host: string) => void;
}

export default function EmbedPlaceholder({
  link,
  decision,
  onAllowHost
}: EmbedPlaceholderProps) {
  const host = embedHost(link);
  return (
    <div className="freeform-embed-placeholder">
      {host && <p className="freeform-embed-placeholder__host">{host}</p>}
      <p>{tUi(MESSAGE_KEYS[decision])}</p>
      {host && (
        <div className="freeform-embed-placeholder__actions">
          {decision === 'blocked' && (
            <button
              type="button"
              className="freeform-embed-placeholder__button freeform-embed-placeholder__button--primary"
              onClick={() => onAllowHost(host)}
            >
              {tUiFormat('freeform.embed.allow', { host })}
            </button>
          )}
          <button
            type="button"
            className="freeform-embed-placeholder__button"
            onClick={() => void openExternalUrl(link)}
          >
            {tUi('freeform.embed.openInBrowser')}
          </button>
        </div>
      )}
    </div>
  );
}
