/*---------------------------------------------------------------------------------------------
 *  Copyright (c) Microsoft Corporation. All rights reserved.
 *  Licensed under the MIT License. See License.txt in the project root for license information.
 *--------------------------------------------------------------------------------------------*/


import { IJSONSchema } from '../../../../../base/common/jsonSchema.js';
import { DisposableMap } from '../../../../../base/common/lifecycle.js';
import { joinPath } from '../../../../../base/common/resources.js';
import { ThemeIcon } from '../../../../../base/common/themables.js';
import { localize } from '../../../../../nls.js';
import { ContextKeyExpr } from '../../../../../platform/contextkey/common/contextkey.js';
import { ExtensionIdentifier } from '../../../../../platform/extensions/common/extensions.js';
import { ILogService } from '../../../../../platform/log/common/log.js';
import { IWorkbenchContribution } from '../../../../common/contributions.js';
import { ILanguageModelToolsService, IToolData } from '../languageModelToolsService.js';
import * as extensionsRegistry from '../../../../services/extensions/common/extensionsRegistry.js';

interface IRawToolContribution {
	name: string;
	name2?: string;
	icon?: string | { light: string; dark: string };
	when?: string;
	tags?: string[];
	displayName?: string;
	userDescription?: string;
	modelDescription: string;
	parametersSchema?: IJSONSchema;
	canBeInvokedManually?: boolean;
	supportedContentTypes?: string[];
	requiresConfirmation?: boolean;
}

const languageModelToolsExtensionPoint = extensionsRegistry.ExtensionsRegistry.registerExtensionPoint<IRawToolContribution[]>({
	extensionPoint: 'languageModelTools',
	activationEventsGenerator: (contributions: IRawToolContribution[], result) => {
		for (const contrib of contributions) {
			result.push(`onLanguageModelTool:${contrib.name}`);
		}
	},
	jsonSchema: {
		description: localize('vscode.extension.contributes.tools', 'Contributes a tool that can be invoked by a language model in a chat session, or from a standalone command. Registered tools can be used by all extensions.'),
		type: 'array',
		items: {
			additionalProperties: false,
			type: 'object',
			defaultSnippets: [{ body: { name: '', description: '' } }],
			required: ['name', 'modelDescription'],
			properties: {
				name: {
					description: localize('toolName', "A unique name for this tool. This name must be a globally unique identifier, and is also used as a name when presenting this tool to an LLM."),
					type: 'string',
					// Borrow OpenAI's requirement for tool names
					pattern: '^[\\w-]+$'
				},
				name2: {
					markdownDescription: localize('toolName2', "If {0} is enabled for this tool, the user may use '#' with this name to invoke the tool in a query. Otherwise, the name is not required. Name must not contain whitespace.", '`canBeInvokedManually`'),
					type: 'string',
					pattern: '^[\\w-]+$'
				},
				displayName: {
					description: localize('toolDisplayName', "A human-readable name for this tool that may be used to describe it in the UI."),
					type: 'string'
				},
				userDescription: {
					description: localize('toolUserDescription', "A description of this tool that may be shown to the user."),
					type: 'string'
				},
				modelDescription: {
					description: localize('toolModelDescription', "A description of this tool that may be passed to a language model."),
					type: 'string'
				},
				parametersSchema: {
					description: localize('parametersSchema', "A JSON schema for the parameters this tool accepts."),
					type: 'object',
					$ref: 'http://json-schema.org/draft-07/schema#'
				},
				canBeInvokedManually: {
					description: localize('canBeInvokedManually', "Whether this tool can be invoked manually by the user through the chat UX."),
					type: 'boolean'
				},
				icon: {
					markdownDescription: localize('icon', "An icon that represents this tool. Either a file path, an object with file paths for dark and light themes, or a theme icon reference, like `$(zap)`"),
					anyOf: [{
						type: 'string'
					},
					{
						type: 'object',
						properties: {
							light: {
								description: localize('icon.light', 'Icon path when a light theme is used'),
								type: 'string'
							},
							dark: {
								description: localize('icon.dark', 'Icon path when a dark theme is used'),
								type: 'string'
							}
						}
					}]
				},
				when: {
					markdownDescription: localize('condition', "Condition which must be true for this tool to be enabled. Note that a tool may still be invoked by another extension even when its `when` condition is false."),
					type: 'string'
				},
				supportedContentTypes: {
					markdownDescription: localize('contentTypes', "The list of content types that this tool can return. It's recommended that all tools support `text/plain`, which would indicate any text-based content. Another example is the contentType exported by the `@vscode/prompt-tsx` library, which would let a tool return a `PromptElementJSON` which can be easily rendered in a prompt by an extension using `@vscode/prompt-tsx`."),
					type: 'array',
					items: {
						type: 'string'
					}
				},
				requiresConfirmation: {
					description: localize('requiresConfirmation', "Whether this tool requires user confirmation before being executed."),
				},
				tags: {
					description: localize('toolTags', "A set of tags that roughly describe the tool's capabilities. A tool user may use these to filter the set of tools to just ones that are relevant for the task at hand."),
					type: 'array',
					items: {
						type: 'string'
					}
				}
			}
		}
	}
});

function toToolKey(extensionIdentifier: ExtensionIdentifier, toolName: string) {
	return `${extensionIdentifier.value}/${toolName}`;
}

export class LanguageModelToolsExtensionPointHandler implements IWorkbenchContribution {
	static readonly ID = 'workbench.contrib.toolsExtensionPointHandler';

	private _registrationDisposables = new DisposableMap<string>();

	constructor(
		@ILanguageModelToolsService languageModelToolsService: ILanguageModelToolsService,
		@ILogService logService: ILogService,
	) {
		languageModelToolsExtensionPoint.setHandler((extensions, delta) => {
			for (const extension of delta.added) {
				for (const rawTool of extension.value) {
					if (!rawTool.name || !rawTool.modelDescription) {
						logService.error(`Extension '${extension.description.identifier.value}' CANNOT register tool without name and modelDescription: ${JSON.stringify(rawTool)}`);
						continue;
					}

					if (!rawTool.name.match(/^[\w-]+$/)) {
						logService.error(`Extension '${extension.description.identifier.value}' CANNOT register tool with invalid id: ${rawTool.name}. The id must match /^[\\w-]+$/.`);
						continue;
					}

					if (rawTool.canBeInvokedManually && !rawTool.name2) {
						logService.error(`Extension '${extension.description.identifier.value}' CANNOT register tool with 'canBeInvokedManually' set without a name: ${JSON.stringify(rawTool)}`);
						continue;
					}

					const rawIcon = rawTool.icon;
					let icon: IToolData['icon'] | undefined;
					if (typeof rawIcon === 'string') {
						icon = ThemeIcon.fromString(rawIcon) ?? {
							dark: joinPath(extension.description.extensionLocation, rawIcon),
							light: joinPath(extension.description.extensionLocation, rawIcon)
						};
					} else if (rawIcon) {
						icon = {
							dark: joinPath(extension.description.extensionLocation, rawIcon.dark),
							light: joinPath(extension.description.extensionLocation, rawIcon.light)
						};
					}

					const tool: IToolData = {
						...rawTool,
						id: rawTool.name,
						icon,
						when: rawTool.when ? ContextKeyExpr.deserialize(rawTool.when) : undefined,
						supportedContentTypes: rawTool.supportedContentTypes ? rawTool.supportedContentTypes : [],
					};
					const disposable = languageModelToolsService.registerToolData(tool);
					this._registrationDisposables.set(toToolKey(extension.description.identifier, rawTool.name), disposable);
				}
			}

			for (const extension of delta.removed) {
				for (const tool of extension.value) {
					this._registrationDisposables.deleteAndDispose(toToolKey(extension.description.identifier, tool.name));
				}
			}
		});
	}
}
