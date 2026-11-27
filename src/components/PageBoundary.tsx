import { Component, type ReactNode } from "react";

import { t } from "@/lib/i18n";
import { attemptStaleModuleAutoReload, clearPwaShellCaches, isStaleModuleError } from "@/lib/stale-module-recovery";

// React unmounts everything below a root that has no error boundary when a render or an effect throws (react.dev,
// "Catching rendering errors with an error boundary"), which left a page showing only the body's background.
export class PageBoundary extends Component<{ children: ReactNode }, { error: Error | null; autoReloading: boolean }> {
  state: { error: Error | null; autoReloading: boolean } = { error: null, autoReloading: false };

  static getDerivedStateFromError(error: unknown) {
    const err = error instanceof Error ? error : new Error(String(error));
    return { error: err, autoReloading: isStaleModuleError(err) };
  }

  componentDidCatch(error: unknown) {
    if (attemptStaleModuleAutoReload(error)) {
      this.setState({ autoReloading: true });
    } else if (this.state.autoReloading) {
      this.setState({ autoReloading: false });
    }
  }

  private handleManualReload = () => {
    void clearPwaShellCaches().finally(() => {
      location.reload();
    });
  };

  render() {
    if (!this.state.error) return this.props.children;
    if (this.state.autoReloading) return null;
    return (
      <div role="alert" className="flex min-h-screen items-center justify-center p-6 text-center">
        <div className="max-w-md space-y-3">
          <h1 className="text-lg font-semibold">{t("page.broken.title")}</h1>
          <p className="text-sm opacity-75">{t("page.broken.body")}</p>
          <p className="break-words text-xs opacity-60">{this.state.error.message}</p>
          <button type="button" className="rounded-md border px-3 py-1.5 text-sm" onClick={this.handleManualReload}>
            {t("page.broken.reload")}
          </button>
        </div>
      </div>
    );
  }
}
