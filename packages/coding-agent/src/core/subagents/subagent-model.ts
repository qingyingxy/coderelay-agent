import { getAgentDir } from "../../config.ts";
import { SettingsManager } from "../settings-manager.ts";

export function resolveSubagentModelName(cwd: string, profileModel: string | undefined): string | undefined {
	if (profileModel) {
		return profileModel;
	}
	const settings = SettingsManager.create(cwd, getAgentDir());
	const provider = settings.getDefaultProvider();
	const model = settings.getDefaultModel();
	if (!provider || !model) {
		return undefined;
	}
	return model.includes("/") ? model : `${provider}/${model}`;
}
