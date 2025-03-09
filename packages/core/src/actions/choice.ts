import { logger } from "../logger";
import { composePrompt } from "../prompts";
import { parseJSONObjectFromText } from "../prompts";
import { getUserServerRole } from "../roles";
import {
	type Action,
	type ActionExample,
	type HandlerCallback,
	type IAgentRuntime,
	type Memory,
	ModelTypes,
	type State,
} from "../types";

/**
 * Task: Extract selected task and option from user message
 *
 * Available Tasks:
 * {{#each tasks}}
 * Task ID: {{taskId}} - {{name}}
 * Available options:
 * {{#each options}}
 * - {{name}}: {{description}}
 * {{/each}}
 * - ABORT: Cancel this task
 * {{/each}}
 *
 * Recent Messages:
 * {{recentMessages}}
 *
 * Instructions:
 * 1. Review the user's message and identify which task and option they are selecting
 * 2. Match against the available tasks and their options, including ABORT
 * 3. Return the task ID (shortened UUID) and selected option name exactly as listed above
 * 4. If no clear selection is made, return null for both fields
 *
 * Return in JSON format:
 * ```json
 * {
 *   "taskId": "string" | null,
 *   "selectedOption": "OPTION_NAME" | null
 * }
 * ```
 *
 * Make sure to include the ```json``` tags around the JSON object.
 */
const optionExtractionTemplate = `# Task: Extract selected task and option from user message

# Available Tasks:
{{#each tasks}}
Task ID: {{taskId}} - {{name}}
Available options:
{{#each options}}
- {{name}}: {{description}}
{{/each}}
- ABORT: Cancel this task

{{/each}}

# Recent Messages:
{{recentMessages}}

# Instructions:
1. Review the user's message and identify which task and option they are selecting
2. Match against the available tasks and their options, including ABORT
3. Return the task ID (shortened UUID) and selected option name exactly as listed above
4. If no clear selection is made, return null for both fields

Return in JSON format:
\`\`\`json
{
  "taskId": "string" | null,
  "selectedOption": "OPTION_NAME" | null
}
\`\`\`

Make sure to include the \`\`\`json\`\`\` tags around the JSON object.`;

/**
 * Represents an action that allows selecting an option for a pending task that has multiple options.
 * @type {Action}
 * @property {string} name - The name of the action
 * @property {string[]} similes - Similar words or phrases for the action
 * @property {string} description - A brief description of the action
 * @property {Function} validate - Asynchronous function to validate the action
 * @property {Function} handler - Asynchronous function to handle the action
 * @property {ActionExample[][]} examples - Examples demonstrating the usage of the action
 */
export const choiceAction: Action = {
	name: "CHOOSE_OPTION",
	similes: ["SELECT_OPTION", "SELECT", "PICK", "CHOOSE"],
	description: "Selects an option for a pending task that has multiple options",

	validate: async (
		runtime: IAgentRuntime,
		message: Memory,
		state: State,
	): Promise<boolean> => {
		// Get all tasks with options metadata
		const pendingTasks = await runtime.getDatabaseAdapter().getTasks({
			roomId: message.roomId,
			tags: ["AWAITING_CHOICE"],
		});

		const room =
			state.data.room ??
			(await runtime.getDatabaseAdapter().getRoom(message.roomId));

		const userRole = await getUserServerRole(
			runtime,
			message.entityId,
			room.serverId,
		);

		if (userRole !== "OWNER" && userRole !== "ADMIN") {
			return false;
		}

		// Only validate if there are pending tasks with options
		return (
			pendingTasks &&
			pendingTasks.length > 0 &&
			pendingTasks.some((task) => task.metadata?.options)
		);
	},

	handler: async (
		runtime: IAgentRuntime,
		message: Memory,
		state: State,
		_options: any,
		callback: HandlerCallback,
		responses: Memory[],
	): Promise<void> => {
		try {
			console.log("*** CHOICE HANDLER ***\n");

			console.log("*** MESSAGE ***\n", JSON.stringify(message, null, 2));

			const pendingTasks = await runtime.getDatabaseAdapter().getTasks({
				roomId: message.roomId,
				tags: ["AWAITING_CHOICE"],
			});

			console.log(
				"*** PENDING TASKS ***\n",
				JSON.stringify(pendingTasks, null, 2),
			);

			if (!pendingTasks?.length) {
				throw new Error("No pending tasks with options found");
			}

			const tasksWithOptions = pendingTasks.filter(
				(task) => task.metadata?.options,
			);

			console.log(
				"*** TASKS WITH OPTIONS ***\n",
				JSON.stringify(tasksWithOptions, null, 2),
			);

			if (!tasksWithOptions.length) {
				throw new Error("No tasks currently have options to select from.");
			}

			// Format tasks with their options for the LLM, using shortened UUIDs
			const formattedTasks = tasksWithOptions.map((task) => {
				// Generate a short ID from the task UUID (first 8 characters should be unique enough)
				const shortId = task.id.substring(0, 8);

				return {
					taskId: shortId,
					fullId: task.id,
					name: task.name,
					options: task.metadata.options.map((opt) => ({
						name: typeof opt === "string" ? opt : opt.name,
						description:
							typeof opt === "string" ? opt : opt.description || opt.name,
					})),
				};
			});

			console.log(
				"*** FORMATTED TASKS ***\n",
				JSON.stringify(formattedTasks, null, 2),
			);

			const prompt = composePrompt({
				state: {
					...state,
					values: {
						...state.values,
						tasks: formattedTasks,
						recentMessages: message.content.text,
					},
				},
				template: optionExtractionTemplate,
			});

			console.log("*** PROMPT ***\n", prompt);

			const result = await runtime.useModel(ModelTypes.TEXT_SMALL, {
				prompt,
				stopSequences: [],
			});

			console.log("*** RESULT ***\n", result);

			const parsed = parseJSONObjectFromText(result);
			const { taskId, selectedOption } = parsed;

			if (taskId && selectedOption) {
				console.log(
					"*** TASK ID AND SELECTED OPTION ***\n",
					taskId,
					selectedOption,
				);

				// Find the task by matching the shortened UUID
				const taskMap = new Map(
					formattedTasks.map((task) => [task.taskId, task]),
				);
				const taskInfo = taskMap.get(taskId);

				if (!taskInfo) {
					await callback({
						text: `Could not find a task matching ID: ${taskId}. Please try again.`,
						actions: ["SELECT_OPTION_ERROR"],
						source: message.content.source,
					});
					return;
				}

				// Find the actual task using the full UUID
				const selectedTask = tasksWithOptions.find(
					(task) => task.id === taskInfo.fullId,
				);

				if (!selectedTask) {
					await callback({
						text: "Error locating the selected task. Please try again.",
						actions: ["SELECT_OPTION_ERROR"],
						source: message.content.source,
					});
					return;
				}

				if (selectedOption === "ABORT") {
					console.log("*** ABORT ***\n");
					await runtime.getDatabaseAdapter().deleteTask(selectedTask.id);
					await callback({
						text: `Task "${selectedTask.name}" has been cancelled.`,
						actions: ["CHOOSE_OPTION_CANCELLED"],
						source: message.content.source,
					});
					return;
				}

				try {
					console.log("selectedTask", JSON.stringify(selectedTask, null, 2));
					const taskWorker = runtime.getTaskWorker(selectedTask.name);
					// ignore
					// @ts-ignore
					console.log("taskWorkers is", runtime.taskWorkers);
					console.log(
						"*** TASK WORKER ***\n",
						JSON.stringify(taskWorker, null, 2),
					);
					await taskWorker.execute(
						runtime,
						{ option: selectedOption },
						selectedTask,
					);
					console.log("*** TASK WORKER EXECUTED ***\n");
					await runtime.getDatabaseAdapter().deleteTask(selectedTask.id);
					console.log("*** TASK DELETED ***\n");
					await callback({
						text: `Selected option: ${selectedOption} for task: ${selectedTask.name}`,
						actions: ["CHOOSE_OPTION"],
						source: message.content.source,
					});
					console.log("*** TASK CALLBACK ***\n");
					return;
				} catch (error) {
					logger.error("Error executing task with option:", error);
					await callback({
						text: "There was an error processing your selection.",
						actions: ["SELECT_OPTION_ERROR"],
						source: message.content.source,
					});
					return;
				}
			}

			// If no task/option was selected, list available options
			let optionsText =
				"Please select a valid option from one of these tasks:\n\n";

			tasksWithOptions.forEach((task) => {
				// Create a shortened UUID for display
				const shortId = task.id.substring(0, 8);

				optionsText += `**${task.name}** (ID: ${shortId}):\n`;
				const options = task.metadata.options.map((opt) =>
					typeof opt === "string" ? opt : opt.name,
				);
				options.push("ABORT");
				optionsText += options.map((opt) => `- ${opt}`).join("\n");
				optionsText += "\n\n";
			});

			await callback({
				text: optionsText,
				actions: ["SELECT_OPTION_INVALID"],
				source: message.content.source,
			});
		} catch (error) {
			logger.error("Error in select option handler:", error);
			await callback({
				text: "There was an error processing the option selection.",
				actions: ["SELECT_OPTION_ERROR"],
				source: message.content.source,
			});
		}
	},

	examples: [
		[
			{
				name: "{{name1}}",
				content: {
					text: "post",
				},
			},
			{
				name: "{{name2}}",
				content: {
					text: "Selected option: post for task: Confirm Twitter Post",
					actions: ["CHOOSE_OPTION"],
				},
			},
		],
		[
			{
				name: "{{name1}}",
				content: {
					text: "I choose cancel",
				},
			},
			{
				name: "{{name2}}",
				content: {
					text: "Selected option: cancel for task: Confirm Twitter Post",
					actions: ["CHOOSE_OPTION"],
				},
			},
		],
	] as ActionExample[][],
};

export default choiceAction;
