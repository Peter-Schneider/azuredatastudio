/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the Source EULA. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/

import { Event } from 'vs/base/common/event';
import { IWorkspaceContextService } from 'vs/platform/workspace/common/workspace';
import { DisposableStore } from 'vs/base/common/lifecycle';
import { IFilesConfiguration, SortOrder } from 'vs/workbench/contrib/files/common/files';
import { ExplorerItem, ExplorerModel } from 'vs/workbench/contrib/files/common/explorerModel';
import { URI } from 'vs/base/common/uri';
import { FileOperationEvent, FileOperation, IFileService, FileChangesEvent, FileChangeType, IResolveFileOptions } from 'vs/platform/files/common/files';
import { dirname } from 'vs/base/common/resources';
import { IConfigurationService, IConfigurationChangeEvent } from 'vs/platform/configuration/common/configuration';
import { IClipboardService } from 'vs/platform/clipboard/common/clipboardService';
import { IEditorService } from 'vs/workbench/services/editor/common/editorService';
import { IEditableData } from 'vs/workbench/common/views';
import { IUriIdentityService } from 'vs/workbench/services/uriIdentity/common/uriIdentity';
import { IBulkEditService, ResourceFileEdit } from 'vs/editor/browser/services/bulkEditService';
import { UndoRedoSource } from 'vs/platform/undoRedo/common/undoRedo';
import { IExplorerView, IExplorerService } from 'vs/workbench/contrib/files/browser/files';
import { IProgressService, ProgressLocation } from 'vs/platform/progress/common/progress';
import { CancellationTokenSource } from 'vs/base/common/cancellation';

export const UNDO_REDO_SOURCE = new UndoRedoSource();

export class ExplorerService implements IExplorerService {
	declare readonly _serviceBrand: undefined;

	private static readonly EXPLORER_FILE_CHANGES_REACT_DELAY = 500; // delay in ms to react to file changes to give our internal events a chance to react first

	private readonly disposables = new DisposableStore();
	private editable: { stat: ExplorerItem, data: IEditableData } | undefined;
	private _sortOrder: SortOrder;
	private cutItems: ExplorerItem[] | undefined;
	private view: IExplorerView | undefined;
	private model: ExplorerModel;

	constructor(
		@IFileService private fileService: IFileService,
		@IConfigurationService private configurationService: IConfigurationService,
		@IWorkspaceContextService private contextService: IWorkspaceContextService,
		@IClipboardService private clipboardService: IClipboardService,
		@IEditorService private editorService: IEditorService,
		@IUriIdentityService private readonly uriIdentityService: IUriIdentityService,
		@IBulkEditService private readonly bulkEditService: IBulkEditService,
		@IProgressService private readonly progressService: IProgressService
	) {
		this._sortOrder = this.configurationService.getValue('explorer.sortOrder');

		this.model = new ExplorerModel(this.contextService, this.uriIdentityService, this.fileService);
		this.disposables.add(this.model);
		this.disposables.add(this.fileService.onDidRunOperation(e => this.onDidRunOperation(e)));
		this.disposables.add(this.fileService.onDidFilesChange(e => this.onDidFilesChange(e)));
		this.disposables.add(this.configurationService.onDidChangeConfiguration(e => this.onConfigurationUpdated(this.configurationService.getValue<IFilesConfiguration>())));
		this.disposables.add(Event.any<{ scheme: string }>(this.fileService.onDidChangeFileSystemProviderRegistrations, this.fileService.onDidChangeFileSystemProviderCapabilities)(async e => {
			let affected = false;
			this.model.roots.forEach(r => {
				if (r.resource.scheme === e.scheme) {
					affected = true;
					r.forgetChildren();
				}
			});
			if (affected) {
				if (this.view) {
					await this.view.refresh(true);
				}
			}
		}));
		this.disposables.add(this.model.onDidChangeRoots(() => {
			if (this.view) {
				this.view.setTreeInput();
			}
		}));
	}

	get roots(): ExplorerItem[] {
		return this.model.roots;
	}

	get sortOrder(): SortOrder {
		return this._sortOrder;
	}

	registerView(contextProvider: IExplorerView): void {
		this.view = contextProvider;
	}

	getContext(respectMultiSelection: boolean): ExplorerItem[] {
		if (!this.view) {
			return [];
		}
		return this.view.getContext(respectMultiSelection);
	}

	async applyBulkEdit(edit: ResourceFileEdit[], options: { undoLabel: string, progressLabel: string }): Promise<void> {
		const cancellationTokenSource = new CancellationTokenSource();
		const promise = this.progressService.withProgress({
			location: ProgressLocation.Window,
			delay: 500,
			title: options.progressLabel,
			cancellable: edit.length > 1 // Only allow cancellation when there is more than one edit. Since cancelling will not actually stop the current edit that is in progress.
		}, async progress => {
			await this.bulkEditService.apply(edit, {
				undoRedoSource: UNDO_REDO_SOURCE,
				label: options.undoLabel,
				progress,
				token: cancellationTokenSource.token
			});
		}, () => cancellationTokenSource.cancel());
		await this.progressService.withProgress({ location: ProgressLocation.Explorer, delay: 500 }, () => promise);
		cancellationTokenSource.dispose();
	}

	hasViewFocus(): boolean {
		return !!this.view && this.view.hasFocus();
	}

	// IExplorerService methods

	findClosest(resource: URI): ExplorerItem | null {
		return this.model.findClosest(resource);
	}

	async setEditable(stat: ExplorerItem, data: IEditableData | null): Promise<void> {
		if (!this.view) {
			return;
		}

		if (!data) {
			this.editable = undefined;
		} else {
			this.editable = { stat, data };
		}
		const isEditing = this.isEditable(stat);
		await this.view.setEditable(stat, isEditing);
	}

	async setToCopy(items: ExplorerItem[], cut: boolean): Promise<void> {
		const previouslyCutItems = this.cutItems;
		this.cutItems = cut ? items : undefined;
		await this.clipboardService.writeResources(items.map(s => s.resource));

		this.view?.itemsCopied(items, cut, previouslyCutItems);
	}

	isCut(item: ExplorerItem): boolean {
		return !!this.cutItems && this.cutItems.indexOf(item) >= 0;
	}

	getEditable(): { stat: ExplorerItem, data: IEditableData } | undefined {
		return this.editable;
	}

	getEditableData(stat: ExplorerItem): IEditableData | undefined {
		return this.editable && this.editable.stat === stat ? this.editable.data : undefined;
	}

	isEditable(stat: ExplorerItem | undefined): boolean {
		return !!this.editable && (this.editable.stat === stat || !stat);
	}

	async select(resource: URI, reveal?: boolean | string): Promise<void> {
		if (!this.view) {
			return;
		}

		const fileStat = this.findClosest(resource);
		if (fileStat) {
			await this.view.selectResource(fileStat.resource, reveal);
			return Promise.resolve(undefined);
		}

		// Stat needs to be resolved first and then revealed
		const options: IResolveFileOptions = { resolveTo: [resource], resolveMetadata: this.sortOrder === SortOrder.Modified };
		const workspaceFolder = this.contextService.getWorkspaceFolder(resource);
		if (workspaceFolder === null) {
			return Promise.resolve(undefined);
		}
		const rootUri = workspaceFolder.uri;

		const root = this.roots.find(r => this.uriIdentityService.extUri.isEqual(r.resource, rootUri))!;

		try {
			const stat = await this.fileService.resolve(rootUri, options);

			// Convert to model
			const modelStat = ExplorerItem.create(this.fileService, stat, undefined, options.resolveTo);
			// Update Input with disk Stat
			ExplorerItem.mergeLocalWithDisk(modelStat, root);
			const item = root.find(resource);
			await this.view.refresh(true, root);

			// Select and Reveal
			await this.view.selectResource(item ? item.resource : undefined, reveal);
		} catch (error) {
			root.isError = true;
			await this.view.refresh(false, root);
		}
	}

	async refresh(reveal = true): Promise<void> {
		this.model.roots.forEach(r => r.forgetChildren());
		if (this.view) {
			await this.view.refresh(true);
			const resource = this.editorService.activeEditor?.resource;
			const autoReveal = this.configurationService.getValue<IFilesConfiguration>().explorer.autoReveal;

			if (reveal && resource && autoReveal) {
				// We did a top level refresh, reveal the active file #67118
				this.select(resource, autoReveal);
			}
		}
	}

	// File events

	private async onDidRunOperation(e: FileOperationEvent): Promise<void> {
		// Add
		if (e.isOperation(FileOperation.CREATE) || e.isOperation(FileOperation.COPY)) {
			const addedElement = e.target;
			const parentResource = dirname(addedElement.resource)!;
			const parents = this.model.findAll(parentResource);

			if (parents.length) {

				// Add the new file to its parent (Model)
				parents.forEach(async p => {
					// We have to check if the parent is resolved #29177
					const resolveMetadata = this.sortOrder === `modified`;
					if (!p.isDirectoryResolved) {
						const stat = await this.fileService.resolve(p.resource, { resolveMetadata });
						if (stat) {
							const modelStat = ExplorerItem.create(this.fileService, stat, p.parent);
							ExplorerItem.mergeLocalWithDisk(modelStat, p);
						}
					}

					const childElement = ExplorerItem.create(this.fileService, addedElement, p.parent);
					// Make sure to remove any previous version of the file if any
					p.removeChild(childElement);
					p.addChild(childElement);
					// Refresh the Parent (View)
					await this.view?.refresh(false, p);
				});
			}
		}

		// Move (including Rename)
		else if (e.isOperation(FileOperation.MOVE)) {
			const oldResource = e.resource;
			const newElement = e.target;
			const oldParentResource = dirname(oldResource);
			const newParentResource = dirname(newElement.resource);

			// Handle Rename
			if (this.uriIdentityService.extUri.isEqual(oldParentResource, newParentResource)) {
				const modelElements = this.model.findAll(oldResource);
				modelElements.forEach(async modelElement => {
					// Rename File (Model)
					modelElement.rename(newElement);
					await this.view?.refresh(false, modelElement.parent);
				});
			}

			// Handle Move
			else {
				const newParents = this.model.findAll(newParentResource);
				const modelElements = this.model.findAll(oldResource);

				if (newParents.length && modelElements.length) {
					// Move in Model
					modelElements.forEach(async (modelElement, index) => {
						const oldParent = modelElement.parent;
						modelElement.move(newParents[index]);
						await this.view?.refresh(false, oldParent);
						await this.view?.refresh(false, newParents[index]);
					});
				}
			}
		}

		// Delete
		else if (e.isOperation(FileOperation.DELETE)) {
			const modelElements = this.model.findAll(e.resource);
			modelElements.forEach(async element => {
				if (element.parent) {
					const parent = element.parent;
					// Remove Element from Parent (Model)
					parent.removeChild(element);
					this.view?.focusNeighbourIfItemFocused(element);
					// Refresh Parent (View)
					await this.view?.refresh(false, parent);
				}
			});
		}
	}

	private onDidFilesChange(e: FileChangesEvent): void {
		// Check if an explorer refresh is necessary (delayed to give internal events a chance to react first)
		// Note: there is no guarantee when the internal events are fired vs real ones. Code has to deal with the fact that one might
		// be fired first over the other or not at all.
		setTimeout(async () => {
			// Filter to the ones we care
			const types = [FileChangeType.ADDED, FileChangeType.DELETED];
			if (this._sortOrder === SortOrder.Modified) {
				types.push(FileChangeType.UPDATED);
			}

			const allResolvedDirectories: ExplorerItem[] = [];
			this.roots.forEach(r => {
				allResolvedDirectories.push(r);
				if (this.view) {
					getAllNonFilteredDescendants(r, allResolvedDirectories, this.view);
				}
			});

			const shouldRefresh = allResolvedDirectories.some(r => e.affects(r.resource, ...types));
			if (shouldRefresh) {
				await this.refresh(false);
			}
		}, ExplorerService.EXPLORER_FILE_CHANGES_REACT_DELAY);
	}

	private async onConfigurationUpdated(configuration: IFilesConfiguration, event?: IConfigurationChangeEvent): Promise<void> {
		const configSortOrder = configuration?.explorer?.sortOrder || 'default';
		if (this._sortOrder !== configSortOrder) {
			const shouldRefresh = this._sortOrder !== undefined;
			this._sortOrder = configSortOrder as SortOrder; // {{SQL CARBON EDIT}} strict-null-checks
			if (shouldRefresh) {
				await this.refresh();
			}
		}
	}

	dispose(): void {
		this.disposables.dispose();
	}
}

function getAllNonFilteredDescendants(item: ExplorerItem, result: ExplorerItem[], view: IExplorerView): void {
	for (let [_name, child] of item.children) {
		if (view.isItemVisible(child)) {
			if (child.isDirectory && child.isDirectoryResolved) {
				result.push(child);
				getAllNonFilteredDescendants(child, result, view);
			}
		}
	}
}
