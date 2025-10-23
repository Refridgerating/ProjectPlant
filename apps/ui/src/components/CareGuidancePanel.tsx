import type { CareProfile, GuidanceBlock } from "@projectplant/care-engine";
import { useCareGuidance } from "../hooks/useCareGuidance";
import classNames from "classnames";
import { CollapsibleTile } from "./CollapsibleTile";

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
      <CollapsibleTile
        id="care-guidance-panel"
        title={title}
        subtitle="No structured guidance available yet."
        className={classNames("border border-slate-800 bg-slate-900/50 p-4 text-sm text-slate-400", className)}
        bodyClassName="mt-3"
        titleClassName="text-sm font-semibold text-slate-200"
        subtitleClassName="text-xs text-slate-400"
      >
        <p>We will surface plant-specific care tasks as soon as the inference engine produces structured recommendations.</p>
      </CollapsibleTile>
    );
  }

  return (
    <CollapsibleTile
      id="care-guidance-panel"
      title={title}
      subtitle={profile.taxon.canonicalName}
      className={classNames(
        "space-y-0 border border-brand-500/40 bg-brand-500/10 p-4 text-sm text-brand-50",
        className
      )}
      bodyClassName="mt-4 space-y-4"
      titleClassName="text-sm font-semibold text-brand-100"
      subtitleClassName="text-xs text-brand-200/70"
      actions={
        <span className="rounded-full border border-brand-500/50 px-2 py-0.5 text-[11px] uppercase tracking-wide text-brand-200/80">
          {profile.metadata.inferenceVersion}
        </span>
      }
    >
      <GuidanceSection title="General" blocks={general} />
      <GuidanceSection title="Indoor" blocks={indoor} emptyHint="No indoor-specific advice yet." />
      <GuidanceSection title="Outdoor" blocks={outdoor} emptyHint="No outdoor-specific advice yet." />
    </CollapsibleTile>
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
