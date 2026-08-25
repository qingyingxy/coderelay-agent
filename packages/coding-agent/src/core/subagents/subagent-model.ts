import { getAgentDir } from "../../config.ts";
import { SettingsManager } from "../settings-manager.ts";

export function resolveSubagentModelName(cwd: string, profileModel: string | undefined): string | undefined {
	if (profileModel) {
		return profileModel;
	}
	const environmentProvider = process.env.PI_PROVIDER?.trim();
	const environmentModel = process.env.PI_MODEL?.trim();
	if (environmentModel) {
		return environmentModel.includes("/") || !environmentProvider
			? environmentModel
			: `${environmentProvider}/${environmentModel}`;
	}
	const settings = SettingsManager.create(cwd, getAgentDir());
	const provider = settings.getDefaultProvider();
	const model = settings.getDefaultModel();
	if (!provider || !model) {
		return undefined;
	}
	return model.includes("/") ? model : `${provider}/${model}`;
}
