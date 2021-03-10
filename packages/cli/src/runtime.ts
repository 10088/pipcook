import * as fs from 'fs-extra';
import {
  PipelineMeta,
  ScriptConfig,
  ScriptType,
  PipcookScript,
  PipcookFramework,
  FrameworkDescFileName,
  ArtifactExports,
  ArtifactMeta,
  constants
} from '@pipcook/pipcook-core';
import { PipelineRunner } from '@pipcook/costa';
import * as path from 'path';
import { URL } from 'url';
import createAdapter from './standalone-impl';
import { logger } from './utils';
import { fetchWithCache } from './utils/cache';
import { install } from './utils/plugin';

/**
 * runtime for local
 */
export class StandaloneRuntime {

  private scriptDir: string;

  private modelDir: string;

  private cacheDir: string;

  private tmpDir: string;

  private frameworkDir: string;

  constructor(
    workspaceDir: string,
    private pipelineConfig: PipelineMeta,
    private enableCache = true
  ) {
    this.scriptDir = path.join(workspaceDir, 'scripts');
    this.cacheDir = path.join(workspaceDir, 'cache');
    this.modelDir = path.join(workspaceDir, 'model');
    this.tmpDir = path.join(workspaceDir, 'tmp');
    this.frameworkDir = path.join(workspaceDir, 'framework');
  }

  async downloadScript(scriptOrder: number, url: string, type: ScriptType): Promise<PipcookScript> {
    const urlObj = new URL(url);
    const baseName = path.parse(urlObj.pathname).base;
    const localPath = path.join(this.scriptDir, `${scriptOrder}-${baseName}`);
    // maybe should copy the script with COW
    await fetchWithCache(constants.PIPCOOK_SCRIPT_PATH, url, localPath, this.enableCache);
    return {
      name: baseName,
      path: localPath,
      type
    };
  }

  async prepareScript(): Promise<ScriptConfig> {
    const scripts: ScriptConfig = {
      dataSource: null,
      dataflow: null,
      model: null
    };
    let scriptOrder = 0;
    scripts.dataSource
      = await this.downloadScript(scriptOrder, this.pipelineConfig.dataSource, ScriptType.DataSource);
    scriptOrder++;
    if (this.pipelineConfig.dataflow) {
      scripts.dataflow = [];
      for (let dataflowUri of this.pipelineConfig.dataflow) {
        scripts.dataflow.push(await this.downloadScript(scriptOrder, dataflowUri, ScriptType.Dataflow));
        scriptOrder++;
      }
    }
    scripts.model = await this.downloadScript(scriptOrder, this.pipelineConfig.model, ScriptType.Model);
    return scripts;
  }

  async prepareWorkSpace(): Promise<void> {
    await Promise.all([
      fs.mkdirp(this.scriptDir),
      fs.mkdirp(this.tmpDir),
      fs.mkdirp(this.modelDir),
      fs.mkdirp(this.cacheDir)
    ]);
    return;
  }

  async prepareArtifactPlugin(): Promise<Array<ArtifactMeta>> {
    if (!this.pipelineConfig.artifacts) {
      return;
    }
    const allPlugins: Array<ArtifactMeta> = [];
    for (let plugin of this.pipelineConfig.artifacts) {
      const requirePath = await install(plugin.processor, constants.PIPCOOK_PLUGIN_ARTIFACT_PATH);
      let pluginExport: ArtifactExports = await import(requirePath);
      if ((pluginExport as any).default
        && typeof (pluginExport as any).default.initialize === 'function'
        && typeof (pluginExport as any).default.build === 'function'
      ) {
        pluginExport = (pluginExport as any).default;
      }
      await pluginExport.initialize(plugin);
      allPlugins.push({
        artifactExports: pluginExport,
        options: plugin
      });
    }
    return allPlugins;
  }

  async run(): Promise<void> {
    await this.prepareWorkSpace();
    logger.info('preparing framework');
    const framework = await this.prepareFramework();
    logger.info('preparing scripts');
    const scripts = await this.prepareScript();
    logger.info('preparing artifact plugins');
    const artifactPlugins = await this.prepareArtifactPlugin();
    const runner = new PipelineRunner({
      workingDir: this.tmpDir,
      dataDir: this.cacheDir,
      modelDir: this.modelDir,
      frameworkDir: this.frameworkDir,
      framework
    });
    logger.info('initalizing framework packages');
    await runner.initFramework();
    logger.info('running data source script');
    let dataSource = await runner.runDataSource(scripts.dataSource, this.pipelineConfig.options);
    logger.info('running data flow script');
    if (scripts.dataflow) {
      dataSource = await runner.runDataflow(scripts.dataflow, this.pipelineConfig.options, dataSource);
    }
    logger.info('running model script');
    const adapter = createAdapter(dataSource, this.pipelineConfig, this.modelDir);
    await runner.runModel(scripts.model, this.pipelineConfig.options, adapter);
    logger.info(`pipeline finished, the model has been saved at ${this.modelDir}`);
    for (let artifact of artifactPlugins) {
      logger.info(`running artifact ${artifact.options.processor}`);
      await artifact.artifactExports.build(this.modelDir, artifact.options);
      logger.info('done');
    }
  }

  async prepareFramework(): Promise<PipcookFramework> {
    if (this.pipelineConfig.options.framework) {
      await fetchWithCache(constants.PIPCOOK_FRAMEWORK_PATH, this.pipelineConfig.options.framework, this.frameworkDir, this.enableCache);
      const framework = await fs.readJson(path.join(this.frameworkDir, FrameworkDescFileName));
      // todo: validate framework
      return {
        pythonPackagePath: framework.pythonPackagePath,
        name: framework.name,
        version: framework.version,
        desc: framework.desc,
        arch: framework.arch,
        platform: framework.platform,
        nodeVersion: framework.nodeVersion,
        path: this.frameworkDir,
        packages: framework.packages
      };
    }
  }
}
