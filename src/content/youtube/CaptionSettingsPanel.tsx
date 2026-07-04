/**
 * Caption appearance panel — the gear popover on the YouTube overlay.
 * Font sizes, per-status colours, underline vs coloured-text mode, and
 * the sidebar toggle. Patches flow up via `onPatch` and persist in
 * chrome.storage (see YouTubeEnhancer's patchCaptionStyle).
 */

import { TOKENS, s } from '../../lib/theme';
import type { CaptionStyle } from './caption-style';

export function CaptionSettingsPanel({
  style,
  onPatch,
  onReset,
  onClose,
  haveKnownData,
  sidebarOpen,
  onToggleSidebar,
}: {
  style: CaptionStyle;
  onPatch: (patch: Partial<CaptionStyle>) => void;
  onReset: () => void;
  onClose: () => void;
  haveKnownData: boolean;
  sidebarOpen: boolean;
  onToggleSidebar: (open: boolean) => void;
}) {
  return (
    <div
      onMouseDown={(e) => e.stopPropagation()}
      onClick={(e) => e.stopPropagation()}
      style={s({
        background: 'rgba(15,17,21,0.96)',
        color: '#e9eaec',
        border: '1px solid rgba(255,255,255,0.12)',
        borderRadius: '10px',
        padding: '12px 14px',
        marginBottom: '6px',
        textAlign: 'left',
        display: 'inline-block',
        minWidth: '300px',
        boxShadow: '0 12px 32px rgba(0,0,0,0.55)',
        fontSize: '12px',
        lineHeight: '1.4',
      })}
    >
      <div
        style={s({
          display: 'flex',
          justifyContent: 'space-between',
          alignItems: 'center',
          marginBottom: '10px',
        })}
      >
        <strong
          style={s({
            fontSize: '12px',
            letterSpacing: '0.04em',
            textTransform: 'uppercase',
            color: TOKENS.textMuted,
          })}
        >
          Caption appearance
        </strong>
        <button
          onClick={onClose}
          aria-label="Close"
          style={s({
            background: 'transparent',
            color: TOKENS.textMuted,
            border: 'none',
            fontSize: '16px',
            cursor: 'pointer',
            lineHeight: '1',
          })}
        >
          ×
        </button>
      </div>

      <Row label="Native size">
        <input
          type="range"
          min={14}
          max={36}
          step={1}
          value={style.nativeFontSize}
          onChange={(e) => onPatch({ nativeFontSize: Number(e.target.value) })}
          style={{ flex: 1 }}
        />
        <span style={s({ color: TOKENS.textMuted, width: '34px', textAlign: 'right' })}>
          {style.nativeFontSize}px
        </span>
      </Row>

      <Row label="EN size">
        <input
          type="range"
          min={11}
          max={28}
          step={1}
          value={style.translatedFontSize}
          onChange={(e) => onPatch({ translatedFontSize: Number(e.target.value) })}
          style={{ flex: 1 }}
        />
        <span style={s({ color: TOKENS.textMuted, width: '34px', textAlign: 'right' })}>
          {style.translatedFontSize}px
        </span>
      </Row>

      <Row label="Native color">
        <ColorField value={style.nativeColor} onChange={(v) => onPatch({ nativeColor: v })} />
      </Row>

      <Row label="EN color">
        <ColorField
          value={style.translatedColor}
          onChange={(v) => onPatch({ translatedColor: v })}
        />
      </Row>

      <div style={s({ borderTop: '1px solid rgba(255,255,255,0.08)', margin: '10px 0 8px' })} />
      <div
        style={s({
          color: TOKENS.textMuted,
          fontSize: '11px',
          marginBottom: '6px',
          textTransform: 'uppercase',
          letterSpacing: '0.05em',
        })}
      >
        Word status colours
      </div>

      <Row label="Style">
        {(
          [
            { value: 'underline', label: 'Underline' },
            { value: 'text', label: 'Colour text' },
          ] as const
        ).map((opt) => (
          <button
            key={opt.value}
            onClick={() => onPatch({ highlightMode: opt.value })}
            style={s({
              flex: 1,
              background:
                style.highlightMode === opt.value ? 'rgba(255,255,255,0.18)' : 'transparent',
              color: style.highlightMode === opt.value ? '#fff' : TOKENS.textMuted,
              border: '1px solid rgba(255,255,255,0.15)',
              borderRadius: '6px',
              padding: '3px 0',
              fontSize: '11px',
              cursor: 'pointer',
            })}
          >
            {opt.label}
          </button>
        ))}
      </Row>

      <Row label="New">
        <ColorField value={style.newColor} onChange={(v) => onPatch({ newColor: v })} />
      </Row>
      <Row label="Learning">
        <ColorField value={style.learningColor} onChange={(v) => onPatch({ learningColor: v })} />
      </Row>
      <Row label="Review">
        <ColorField value={style.reviewColor} onChange={(v) => onPatch({ reviewColor: v })} />
      </Row>
      <Row label="Known">
        <ColorField value={style.knownColor} onChange={(v) => onPatch({ knownColor: v })} />
      </Row>
      <Row label="Unseen">
        <ColorField value={style.unseenColor} onChange={(v) => onPatch({ unseenColor: v })} />
      </Row>

      <label
        style={s({
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          marginTop: '8px',
          cursor: 'pointer',
        })}
      >
        <input
          type="checkbox"
          checked={style.highlightUnseen}
          onChange={(e) => onPatch({ highlightUnseen: e.target.checked })}
        />
        <span style={s({ color: TOKENS.text })}>Mark unseen words</span>
        {!haveKnownData && (
          <span style={s({ color: TOKENS.textMuted, fontSize: '10px' })}>
            (needs paired desktop)
          </span>
        )}
      </label>

      <label
        style={s({
          display: 'flex',
          alignItems: 'center',
          gap: '6px',
          marginTop: '8px',
          cursor: 'pointer',
        })}
      >
        <input
          type="checkbox"
          checked={sidebarOpen}
          onChange={(e) => onToggleSidebar(e.target.checked)}
        />
        <span style={s({ color: TOKENS.text })}>Caption sidebar</span>
        <span style={s({ color: TOKENS.textMuted, fontSize: '10px' })}>
          (transcript next to the video)
        </span>
      </label>

      <div style={s({ display: 'flex', justifyContent: 'flex-end', marginTop: '10px' })}>
        <button
          onClick={onReset}
          style={s({
            background: 'transparent',
            color: TOKENS.textMuted,
            border: '1px solid rgba(255,255,255,0.15)',
            borderRadius: '6px',
            padding: '4px 10px',
            fontSize: '11px',
            cursor: 'pointer',
          })}
        >
          Reset to defaults
        </button>
      </div>
    </div>
  );
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div style={s({ display: 'flex', alignItems: 'center', gap: '8px', marginBottom: '6px' })}>
      <span style={s({ width: '90px', color: TOKENS.textMuted })}>{label}</span>
      {children}
    </div>
  );
}

function ColorField({ value, onChange }: { value: string; onChange: (v: string) => void }) {
  return (
    <div style={s({ display: 'flex', alignItems: 'center', gap: '6px', flex: 1 })}>
      <input
        type="color"
        value={normalizeColorForInput(value)}
        onChange={(e) => onChange(e.target.value)}
        style={s({
          width: '28px',
          height: '22px',
          border: 'none',
          padding: 0,
          background: 'transparent',
          cursor: 'pointer',
        })}
      />
      <input
        type="text"
        value={value}
        onChange={(e) => onChange(e.target.value)}
        style={s({
          flex: 1,
          background: 'rgba(255,255,255,0.05)',
          color: '#e9eaec',
          border: '1px solid rgba(255,255,255,0.12)',
          borderRadius: '4px',
          padding: '3px 6px',
          fontSize: '11px',
          fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace',
        })}
      />
    </div>
  );
}

/** <input type="color"> only accepts `#rrggbb` — strip rgba()/named
 *  values down to a hex fallback so the picker stays usable even when
 *  the textual value is something fancier. */
function normalizeColorForInput(v: string): string {
  if (/^#[0-9a-f]{6}$/i.test(v)) return v;
  if (/^#[0-9a-f]{3}$/i.test(v)) {
    const r = v[1],
      g = v[2],
      b = v[3];
    return `#${r}${r}${g}${g}${b}${b}`;
  }
  return '#ffffff';
}
