import * as fs from 'fs-extra';
import {
  PipelineMeta,
  ScriptConfig,
  ScriptType,
  PipcookScript,
  download,
  downloadAndExtractTo,
  PipcookFramework,
  FrameworkDescFileName
} from '@pipcook/pipcook-core';
import { PipelineRunner } from '@pipcook/costa';
import * as path from 'path';
import { URL } from 'url';
import createAdapter from './standalone-impl';

/**
 * runtime for local
 */
export class StandaloneRuntime {

  private scriptDir: string;

  private modelDir: string;

  private cacheDir: string;

  private tmpDir: string;

  constructor(
    workspaceDir: string,
    private pipelineConfig: PipelineMeta
  ) {
    this.scriptDir = path.join(workspaceDir, 'scripts');
    this.cacheDir = path.join(workspaceDir, 'cache');
    this.modelDir = path.join(workspaceDir, 'model');
    this.tmpDir = path.join(workspaceDir, 'tmp');
  }

  async downloadScript(scriptOrder: number, url: string, type: ScriptType): Promise<PipcookScript> {
    const urlObj = new URL(url);
    const baseName = path.parse(urlObj.pathname).base;
    const localPath = path.join(this.scriptDir, `${scriptOrder}-${baseName}`);
    await download(url, localPath);
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
    scripts.dataSource = await this.downloadScript(scriptOrder, this.pipelineConfig.dataSource, ScriptType.DataSource);
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

  async run(): Promise<void> {
    const framework = await this.prepareFramework();
    await this.prepareWorkSpace();
    const scripts = await this.prepareScript();
    const runnable = new PipelineRunner(this.tmpDir, this.tmpDir, this.modelDir, framework);
    let dataAPI = await runnable.runDataSource(scripts.dataSource, this.pipelineConfig.options);
    if (scripts.dataflow) {
      dataAPI = await runnable.runDataflow(scripts.dataflow, this.pipelineConfig.options, dataAPI);
    }
    const adapter = createAdapter(this.pipelineConfig, dataAPI);
    runnable.runModel(scripts.model, this.pipelineConfig.options, adapter);
  }

  async prepareFramework(): Promise<PipcookFramework> {
    if (this.pipelineConfig.options.framework) {
      const urlObj = new URL(this.pipelineConfig.options.framework);
      const dirName = path.parse(urlObj.pathname).name;
      const localPath = path.join(this.scriptDir, dirName);
      await downloadAndExtractTo(this.pipelineConfig.options.framework, localPath);
      const framework = await fs.readJson(path.join(localPath, FrameworkDescFileName));
      const requirePath = framework.requirePath ? framework.requirePath : `node_modules/${framework.name}`;
      // todo: validate framework
      return {
        type: framework.type,
        name: framework.name,
        version: framework.version,
        path: path.join(localPath, requirePath)
      };
    }
  }
}
