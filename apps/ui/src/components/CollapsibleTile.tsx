import { ChevronDownIcon } from "@heroicons/react/24/outline";
import classNames from "classnames";
import {
  type ReactNode,
  useCallback,
  useEffect,
  useId,
  useMemo,
  useState,
} from "react";

type HeadingLevel = "h2" | "h3" | "h4";

type CollapsibleTileProps = {
  /**
   * Unique identifier used to persist collapse state in localStorage.
   */
  id: string;
  /**
   * Primary heading content rendered inside the toggle button.
   */
  title: ReactNode;
  /**
   * Optional secondary line rendered beneath the title.
   */
  subtitle?: ReactNode;
  /**
   * Rendered on the right-hand side of the header.
   */
  actions?: ReactNode;
  /**
   * Content shown when the tile is expanded.
   */
  children: ReactNode;
  /**
   * Tailwind utility classes applied to the outer section element.
   */
  className?: string;
  /**
   * Tailwind classes applied to the content wrapper.
   */
  bodyClassName?: string;
  /**
   * Optional override for the heading level used for accessibility.
   */
  headingLevel?: HeadingLevel;
  /**
   * Initial collapsed state when nothing is stored yet.
   */
  defaultCollapsed?: boolean;
  /**
   * When false the collapsed state is not persisted.
   */
  persistState?: boolean;
  /**
   * Class names applied to the title text container.
   */
  titleClassName?: string;
  /**
   * Class names applied to the subtitle text container.
   */
  subtitleClassName?: string;
};

const STORAGE_PREFIX = "projectplant:tile:";

function readInitialState(id: string, fallback: boolean, persist: boolean) {
  if (!persist || typeof window === "undefined") {
    return fallback;
  }
  try {
    const raw = window.localStorage.getItem(`${STORAGE_PREFIX}${id}`);
    if (raw === null) {
      return fallback;
    }
    return raw === "collapsed";
  } catch {
    return fallback;
  }
}

function writeState(id: string, collapsed: boolean, persist: boolean) {
  if (!persist || typeof window === "undefined") {
    return;
  }
  try {
    window.localStorage.setItem(`${STORAGE_PREFIX}${id}`, collapsed ? "collapsed" : "expanded");
  } catch {
    // localStorage might be unavailable (private mode, etc). Ignore errors.
  }
}

export function CollapsibleTile({
  id,
  title,
  subtitle,
  actions,
  children,
  className,
  bodyClassName = "mt-4",
  headingLevel = "h3",
  defaultCollapsed = false,
  persistState = true,
  titleClassName = "text-base font-semibold text-emerald-50",
  subtitleClassName = "text-xs text-emerald-200/70",
}: CollapsibleTileProps) {
  const [collapsed, setCollapsed] = useState(() => readInitialState(id, defaultCollapsed, persistState));
  const buttonId = useId();
  const contentId = useMemo(() => `${id.replace(/[^a-zA-Z0-9_-]/g, "-")}-content`, [id]);

  useEffect(() => {
    writeState(id, collapsed, persistState);
  }, [collapsed, id, persistState]);

  const toggle = useCallback(() => {
    setCollapsed((prev) => !prev);
  }, []);

  const HeadingTag = headingLevel;

  const subtitleContent =
    subtitle === undefined || subtitle === null
      ? null
      : typeof subtitle === "string"
      ? (
          <span className={subtitleClassName}>{subtitle}</span>
        )
      : (
          <span className={subtitleClassName}>{subtitle}</span>
        );

  return (
    <section
      className={classNames(
        "rounded-2xl border border-emerald-800/40 bg-[rgba(7,31,21,0.78)] p-6 shadow-[0_25px_60px_rgba(5,22,15,0.45)] backdrop-blur-sm",
        className
      )}
      data-collapsible-tile=""
    >
      <div className="flex flex-wrap items-center justify-between gap-3">
        <button
          id={buttonId}
          type="button"
          onClick={toggle}
          className="group inline-flex min-w-0 flex-1 items-center gap-2 text-left"
          aria-expanded={!collapsed}
          aria-controls={contentId}
        >
          <ChevronDownIcon
            className={classNames(
              "h-5 w-5 flex-shrink-0 text-emerald-300/70 transition-transform duration-150 group-hover:text-emerald-200",
              collapsed ? "-rotate-90" : "rotate-0"
            )}
            aria-hidden="true"
          />
          <span className="flex min-w-0 flex-1 flex-col">
            <HeadingTag className={classNames("truncate", titleClassName)}>
              {title}
            </HeadingTag>
            {subtitleContent}
          </span>
        </button>
        {actions ? <div className="flex flex-shrink-0 items-center gap-2">{actions}</div> : null}
      </div>
      <div
        id={contentId}
        role="region"
        aria-labelledby={buttonId}
        hidden={collapsed}
        className={collapsed ? undefined : bodyClassName}
      >
        {collapsed ? null : children}
      </div>
    </section>
  );
}
