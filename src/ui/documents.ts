// Read-only JSON documents: inspect / stats / system status / df results are shown as virtual documents

import * as vscode from 'vscode';

export const DOCUMENT_SCHEME = 'apple-container';

type Loader = () => Promise<string>;

export class ReadonlyDocumentProvider implements vscode.TextDocumentContentProvider, vscode.Disposable {
  private readonly loaders = new Map<string, Loader>();
  private readonly emitter = new vscode.EventEmitter<vscode.Uri>();
  readonly onDidChange = this.emitter.event;

  async provideTextDocumentContent(uri: vscode.Uri): Promise<string> {
    const loader = this.loaders.get(uri.toString());
    return loader ? loader() : '';
  }

  /** Opens (or refreshes an already open) document; reopening the same path reloads its content */
  async open(path: string, loader: Loader): Promise<void> {
    const uri = vscode.Uri.from({ scheme: DOCUMENT_SCHEME, path });
    this.loaders.set(uri.toString(), loader);
    this.emitter.fire(uri);
    const doc = await vscode.workspace.openTextDocument(uri);
    await vscode.languages.setTextDocumentLanguage(doc, 'json');
    await vscode.window.showTextDocument(doc, { preview: true });
  }

  dispose(): void {
    this.emitter.dispose();
  }
}
