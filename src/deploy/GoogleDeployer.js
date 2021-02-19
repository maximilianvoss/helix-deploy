/*
 * Copyright 2021 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */
const { CloudFunctionsServiceClient } = require('@google-cloud/functions');
const path = require('path');
const fs = require('fs');
const { context } = require('@adobe/helix-fetch');
const BaseDeployer = require('./BaseDeployer');
const GoogleConfig = require('./GoogleConfig.js');

const { fetch } = context();

class GoogleDeployer extends BaseDeployer {
  constructor(baseConfig, config) {
    super(baseConfig);
    Object.assign(this, {
      id: 'google',
      name: 'Google',
      _cfg: config,
      _client: null,
    });
  }

  ready() {
    return !!this._client;
  }

  validate() {
    if (!this.ready()) {
      throw new Error('Google target needs key file, email, and project ID');
    }
  }

  async init() {
    try {
      this._client = new CloudFunctionsServiceClient({
        email: this._cfg.email,
        keyFilename: path.resolve(process.cwd, this._cfg.keyFile),
        projectId: this._cfg.projectID,
      });
    } catch (e) {
      this.log.error(`Unable to authenticate with Google: ${e.message}`);
      throw e;
    }
  }

  async uploadZIP() {
    const [{ uploadUrl }] = await this._client.generateUploadUrl({
      parent: `projects/${this._cfg.projectID}/locations/${this._cfg.region}`,
    });

    const body = fs.createReadStream(this.cfg.zipFile);

    // upload
    await fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        'Content-Type': 'application/zip',
        'x-goog-content-length-range': '0,104857600',
      },
      body,
    });

    this._uploadURL = uploadUrl;
  }

  get fullFunctionName() {
    return `${this.cfg.packageName}--${this.cfg.name}`
      .replace(/\./g, '_')
      .replace('@', '_');
  }

  async createFunction() {
    const name = `projects/${this._cfg.projectID}/locations/${this._cfg.region}/functions/${this.fullFunctionName}`;
    let exists = false;

    try {
      await this._client.getFunction({
        name,
      });
      exists = true;
    } catch {
      exists = false;
    }

    try {
      const func = {
        name,
        serviceAccountEmail: this._cfg.email,
        description: this.cfg.pkgJson.description,
        entryPoint: 'google',
        runtime: `nodejs${this.cfg.nodeVersion}`,
        // timeout: `${Math.floor(this.cfg.timeout / 1000)}s`,
        availableMemoryMb: this.cfg.memory,
        labels: {
          /*
           * Each resource can have multiple labels, up to a maximum of 64.
           * - Each label must be a key-value pair.
           * - Keys have a minimum length of 1 character and a maximum length of 63
           *   characters, and cannot be empty. Values can be empty, and have a maximum
           *   length of 63 characters.
           * - Keys and values can contain only lowercase letters, numeric characters,
           *   underscores, and dashes. All characters must use UTF-8 encoding, and
           *   international characters are allowed.
           * - The key portion of a label must be unique. However, you can use the same key
           *   with multiple resources.
           * - Keys must start with a lowercase letter or international character.
           */
          // not worth the effort, I think
          pkgversion: `${encodeURIComponent(this.cfg.version.replace(/\./g, '_'))}`,
          // dependencies: this.cfg.dependencies.main
          //  .map((dep) => `${dep.name}:${dep.version}`).join(','),
          // repository: encodeURIComponent(this.cfg.gitUrl).replace(/%/g, '_'),
          // git: `${this.cfg.gitOrigin}#${this.cfg.gitRef}`,
          updated: `${this.cfg.updatedAt}`,
        },
        environmentVariables: this.cfg.params,
        httpsTrigger: {},
        sourceUploadUrl: this._uploadURL,
      };

      if (exists) {
        const [op] = await this._client.updateFunction({
          // location: `projects/${this._cfg.projectID}/locations/${this._cfg.region}`,
          function: func,
        });

        this.log.info('updating existing function');
        const [res] = await op.promise();
        this._function = res;
        this.log.info('function deployed');
      } else {
        const [op] = await this._client.createFunction({
          location: `projects/${this._cfg.projectID}/locations/${this._cfg.region}`,
          function: func,
        });

        this.log.info('creating function, please wait (Google deployments are slow).');
        const [res] = await op.promise();
        this._function = res;
        this.log.info('function deployed');
      }

      this.log.info('enabling unauthenticated requests');
      await this._client.setIamPolicy({
        resource: name,
        policy: {
          bindings: [
            {
              role: 'roles/cloudfunctions.invoker',
              members: [
                'allUsers',
              ],
            },
          ],
        },
      });
    } catch (err) {
      this.log.error(err);
      // eslint-disable-next-line max-len
      this.log.error('bad request:', err.metadata.internalRepr.get('google.rpc.badrequest-bin').toString());
      // eslint-disable-next-line max-len
      this.log.error('details:', err.metadata.internalRepr.get('grpc-status-details-bin').toString());
      throw err;
    }

    this._functionURL = this._function.httpsTrigger.url;
  }

  async deploy() {
    try {
      await this.uploadZIP();
      await this.createFunction();
    } catch (err) {
      this.log.error(`Unable to deploy Google Cloud function: ${err.message}`, err);
      throw err;
    }
  }

  async test() {
    let url = this._functionURL;
    if (!url) {
      url = `https://${this._cfg.region}-${this._cfg.projectID}.cloudfunctions.net/${this.fullFunctionName}`;
    }
    return this.testRequest({
      url,
      idHeader: 'X-Cloud-Trace-Context',
      retry404: 1,
    });
  }
}

GoogleDeployer.Config = GoogleConfig;
module.exports = GoogleDeployer;
