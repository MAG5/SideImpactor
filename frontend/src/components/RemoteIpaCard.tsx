import { Button } from './ui/Button';

export type RemoteIpaPhase = 'resolving' | 'downloading' | 'ready' | 'error';

export interface RemoteIpaView {
  label: string;
  phase: RemoteIpaPhase;
  detail: string;
  percent: number | null;
  error: string | null;
  manualUrl: string | null;
  viaProxy: boolean;
  digestVerified: boolean;
}

interface RemoteIpaCardProps {
  view: RemoteIpaView;
  onInstall: () => void;
  installBusy: boolean;
  installDisabled: boolean;
}

export function RemoteIpaCard({ view, onInstall, installBusy, installDisabled }: RemoteIpaCardProps) {
  const showProgress = view.phase === 'downloading';

  return (
    <div className="card card-pad">
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11.5px] font-medium uppercase tracking-wider text-subtle">Remote IPA</p>
          <p className="mt-1 truncate text-[14px] font-medium text-ink" title={view.label}>
            {view.label}
          </p>
          <p className="mt-0.5 text-[12.5px] text-muted">{view.detail}</p>
        </div>

        {view.phase === 'ready' ? (
          <Button
            variant="primary"
            busy={installBusy}
            busyLabel="Signing & Installing…"
            disabled={installDisabled}
            onClick={onInstall}
            className="min-w-[160px]"
          >
            Install Now
          </Button>
        ) : null}
      </div>

      {showProgress ? (
        <div className="mt-3">
          <div className="h-1.5 w-full overflow-hidden rounded-full bg-[var(--color-surface)]">
            <div
              className={`h-full rounded-full bg-[var(--color-accent)]${view.percent == null ? ' animate-pulse' : ''}`}
              style={{ width: view.percent == null ? '100%' : `${Math.max(2, view.percent)}%` }}
            />
          </div>
          <p className="mt-1.5 text-[12px] text-muted">
            {view.percent == null ? 'Downloading…' : `Downloading… ${view.percent}%`}
          </p>
        </div>
      ) : null}

      {view.phase === 'ready' ? (
        <div className="mt-3 flex flex-wrap items-center gap-2 text-[11.5px]">
          <span className="rounded-full bg-[var(--color-success-soft)] px-2 py-0.5 font-medium text-[var(--color-success)]">
            Ready
          </span>
          {view.digestVerified ? (
            <span className="rounded-full bg-[var(--color-success-soft)] px-2 py-0.5 font-medium text-[var(--color-success)]">
              SHA-256 verified
            </span>
          ) : null}
          {view.viaProxy ? (
            <span className="rounded-full bg-[var(--color-accent-soft)] px-2 py-0.5 font-medium text-accent">
              via public mirror
            </span>
          ) : null}
        </div>
      ) : null}

      {view.phase === 'error' ? (
        <div className="mt-3 rounded-lg bg-[var(--color-danger-soft)] px-3 py-2 text-[12.5px] text-[var(--color-danger)]">
          <p>{view.error}</p>
          {view.manualUrl ? (
            <a
              href={view.manualUrl}
              target="_blank"
              rel="noreferrer noopener"
              className="mt-1 inline-block underline underline-offset-2"
            >
              Open download link
            </a>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}
