import prompts from 'prompts';
import type { CLIOptions, CoreConfig } from '@storybook/types';
import { loadAllPresets, cache } from '@storybook/core-common';
import { telemetry, getPrecedingUpgrade, oneWayHash } from '@storybook/telemetry';
import type { EventType } from '@storybook/telemetry';
import { logger } from '@storybook/node-logger';
import invariant from 'tiny-invariant';

type TelemetryOptions = {
  cliOptions: CLIOptions;
  presetOptions?: Parameters<typeof loadAllPresets>[0];
  printError?: (err: any) => void;
  skipPrompt?: boolean;
};

const promptCrashReports = async () => {
  if (process.env.CI && process.env.NODE_ENV !== 'test') {
    return undefined;
  }

  const { enableCrashReports } = await prompts({
    type: 'confirm',
    name: 'enableCrashReports',
    message: `Would you like to help improve Storybook by sending anonymous crash reports?`,
    initial: true,
  });

  await cache.set('enableCrashReports', enableCrashReports);

  return enableCrashReports;
};

type ErrorLevel = 'none' | 'error' | 'full';

async function getErrorLevel({
  cliOptions,
  presetOptions,
  skipPrompt,
}: TelemetryOptions): Promise<ErrorLevel> {
  if (cliOptions.disableTelemetry) return 'none';

  // If we are running init or similar, we just have to go with true here
  if (!presetOptions) return 'full';

  // should we load the preset?
  const presets = await loadAllPresets(presetOptions);

  // If the user has chosen to enable/disable crash reports in main.js
  // or disabled telemetry, we can return that
  const core = await presets.apply<CoreConfig>('core');
  if (core?.enableCrashReports !== undefined) return core.enableCrashReports ? 'full' : 'error';
  if (core?.disableTelemetry) return 'none';

  // Deal with typo, remove in future version (7.1?)
  const valueFromCache =
    (await cache.get('enableCrashReports')) ?? (await cache.get('enableCrashreports'));
  if (valueFromCache !== undefined) return valueFromCache ? 'full' : 'error';

  if (skipPrompt) {
    return 'error';
  }

  const valueFromPrompt = await promptCrashReports();
  if (valueFromPrompt !== undefined) return valueFromPrompt ? 'full' : 'error';

  return 'full';
}

export async function sendTelemetryError(
  error: unknown,
  eventType: EventType,
  options: TelemetryOptions
) {
  try {
    let errorLevel = 'error';
    try {
      errorLevel = await getErrorLevel(options);
    } catch (err) {
      // If this throws, eg. due to main.js breaking, we fall back to 'error'
    }
    if (errorLevel !== 'none') {
      const precedingUpgrade = await getPrecedingUpgrade();

      invariant(
        error instanceof Error,
        'The error passed to sendTelemetryError was not an Error, please only send Errors'
      );
      await telemetry(
        'error',
        {
          eventType,
          precedingUpgrade,
          error: errorLevel === 'full' ? error : undefined,
          errorHash: oneWayHash(error.message),
        },
        {
          immediate: true,
          configDir: options.cliOptions.configDir || options.presetOptions?.configDir,
          enableCrashReports: errorLevel === 'full',
        }
      );
    }
  } catch (err) {
    // if this throws an error, we just move on
  }
}

export async function withTelemetry<T>(
  eventType: EventType,
  options: TelemetryOptions,
  run: () => Promise<T>
): Promise<T | undefined> {
  let canceled = false;

  async function cancelTelemetry() {
    canceled = true;
    if (!options.cliOptions.disableTelemetry) {
      await telemetry('canceled', { eventType }, { stripMetadata: true, immediate: true });
    }

    process.exit(0);
  }

  if (eventType === 'init') {
    // We catch Ctrl+C user interactions to be able to detect a cancel event
    process.on('SIGINT', cancelTelemetry);
  }

  if (!options.cliOptions.disableTelemetry)
    telemetry('boot', { eventType }, { stripMetadata: true });

  try {
    return await run();
  } catch (error) {
    if (canceled) {
      return undefined;
    }

    const { printError = logger.error } = options;
    printError(error);
    await sendTelemetryError(error, eventType, options);

    throw error;
  } finally {
    process.off('SIGINIT', cancelTelemetry);
  }
}
