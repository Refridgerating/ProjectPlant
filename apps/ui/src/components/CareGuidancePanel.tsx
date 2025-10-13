import type { CareProfile, GuidanceBlock } from "@projectplant/care-engine";
import { useCareGuidance } from "../hooks/useCareGuidance";
import classNames from "classnames";

type CareGuidancePanelProps = {
  profile: CareProfile | null;
  className?: string;
  title?: string;
};

export function CareGuidancePanel({ profile, className, title = "Care Guidance Preview" }: CareGuidancePanelProps) {
  const { general, indoor, outdoor } = useCareGuidance(profile);
  const hasData = general.length + indoor.length + outdoor.length > 0;

  if (!profile || !hasData) {
    return (
      <section
        className={classNames(
          "rounded-xl border border-slate-800 bg-slate-900/50 p-4 text-sm text-slate-400",
          className
        )}
      >
        No structured guidance available yet.
      </section>
    );
  }

  return (
    <section
      className={classNames(
        "space-y-4 rounded-xl border border-brand-500/40 bg-brand-500/10 p-4 text-sm text-brand-50",
        className
      )}
    >
      <header className="flex items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-brand-100">{title}</h3>
          <p className="text-xs text-brand-200/70">{profile.taxon.canonicalName}</p>
        </div>
        <span className="rounded-full border border-brand-500/50 px-2 py-0.5 text-[11px] uppercase tracking-wide text-brand-200/80">
          {profile.metadata.inferenceVersion}
        </span>
      </header>
      <GuidanceSection title="General" blocks={general} />
      <GuidanceSection title="Indoor" blocks={indoor} emptyHint="No indoor-specific advice yet." />
      <GuidanceSection title="Outdoor" blocks={outdoor} emptyHint="No outdoor-specific advice yet." />
    </section>
  );
}

function GuidanceSection({
  title,
  blocks,
  emptyHint
}: {
  title: string;
  blocks: GuidanceBlock[];
  emptyHint?: string;
}) {
  if (blocks.length === 0) {
    return (
      <div>
        <h4 className="text-xs font-semibold uppercase tracking-wide text-brand-200/80">{title}</h4>
        {emptyHint ? <p className="mt-1 text-xs text-brand-200/60">{emptyHint}</p> : null}
      </div>
    );
  }

  return (
    <div>
      <h4 className="text-xs font-semibold uppercase tracking-wide text-brand-200/80">{title}</h4>
      <ul className="mt-2 space-y-3">
        {blocks.map((block) => (
          <li key={block.id} className="rounded-lg border border-brand-500/30 bg-brand-500/15 p-3">
            <p className="text-sm font-medium text-brand-50">{block.summary}</p>
            {block.details?.length ? (
              <ul className="mt-2 list-disc space-y-1 pl-4 text-xs text-brand-200">
                {block.details.map((detail, index) => (
                  <li key={index}>{detail}</li>
                ))}
              </ul>
            ) : null}
            <footer className="mt-2 flex items-center justify-between text-[11px] uppercase tracking-wide text-brand-200/60">
              <span>{block.confidence ? `${block.confidence.level} confidence` : "Derived"}</span>
              {block.evidence?.length ? <span>{block.evidence[0].source.name ?? block.evidence[0].source.id}</span> : null}
            </footer>
          </li>
        ))}
      </ul>
    </div>
  );
}
