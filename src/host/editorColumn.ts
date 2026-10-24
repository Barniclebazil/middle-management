// Which editor column a file or diff opened from the office should use. No `vscode` import: the caller passes the numbers.

/**
 * When the office is open in an editor tab (`panelColumn` is that tab's column), open files beside it, so the office tab is not
 * replaced and its webview is not torn down. Undefined when the office is the sidebar view: the editor's own choice stands.
 * `beside` is `vscode.ViewColumn.Beside`.
 */
export function besideOfficePanel(panelColumn: number | undefined, beside: number): number | undefined {
  return panelColumn === undefined ? undefined : beside;
}
