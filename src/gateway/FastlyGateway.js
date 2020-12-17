/*
 * Copyright 2020 Adobe. All rights reserved.
 * This file is licensed to you under the Apache License, Version 2.0 (the "License");
 * you may not use this file except in compliance with the License. You may obtain a copy
 * of the License at http://www.apache.org/licenses/LICENSE-2.0
 *
 * Unless required by applicable law or agreed to in writing, software distributed under
 * the License is distributed on an "AS IS" BASIS, WITHOUT WARRANTIES OR REPRESENTATIONS
 * OF ANY KIND, either express or implied. See the License for the specific language
 * governing permissions and limitations under the License.
 */
const Fastly = require('@adobe/fastly-native-promises');

class FastlyGateway {
  constructor(builder) {
    this._builder = builder;
    this._service = undefined;
    this._auth = undefined;
    this._fastly = null;
    this._deployers = [];
    this._checkpath = '';
  }

  ready() {
    return !!this._service && !!this._auth && !!this._checkpath;
  }

  init() {
    if (this.ready() && !this._fastly) {
      this._fastly = Fastly(this._auth, this._service);
    }
  }

  withAuth(value) {
    this._auth = value;
    return this;
  }

  withServiceID(value) {
    this._service = value;
    return this;
  }

  withDeployer(value) {
    this._deployers.push(value);
    return this;
  }

  withCheckpath(value) {
    this._checkpath = value;
    return this;
  }

  get log() {
    return this._builder.log;
  }

  selectBackendVCL() {
    const vcl = `
      declare local var.i INTEGER;
      set var.i = randomint(0, ${this._deployers.length - 1});

      if (false) {}`;

    const middle = this._deployers.map((deployer, i) => `if(var.i <= ${i} && backend.F_${deployer.name}.healthy) {
      set req.backend = F_${deployer.name};
    }`);

    const fallback = `{
      set req.backend = F_${this._deployers[0].name};
      ${this._deployers[0].customVCL}
    }`;

    return [vcl, ...middle, fallback].join(' else ');
  }

  setURLVCL() {
    return this._deployers.map((deployer) => `
      if (req.backend == F_${deployer.name}) {
        set bereq.url = ${deployer.urlVCL};
      }
      `).join('\n');
  }

  async deploy() {
    this.log.info('Set up Fastly Gateway');

    await this._fastly.transact(async (newversion) => {
      // create condition
      await this._fastly.writeCondition(newversion, 'false', {
        name: 'false',
        statement: 'false',
        type: 'request',
      });

      // set up health checks
      await Promise.all(this._deployers
        .map((deployer) => ({
          check_interval: 60000,
          expected_response: 200,
          host: deployer.host,
          http_version: '1.1',
          method: 'GET',
          initial: 1,
          name: `${deployer.name}Check`,
          path: deployer.basePath + this._checkpath,
          threshold: 1,
          timeout: 5000,
          window: 2,
        }))
        .map((healthcheck) => this._fastly
          .writeHealthcheck(newversion, healthcheck.name, healthcheck)));

      // set up backends
      await Promise.all(this._deployers
        .map((deployer) => ({
          hostname: deployer.host,
          ssl_cert_hostname: deployer.host,
          ssl_sni_hostname: deployer.host,
          address: deployer.host,
          override_host: deployer.host,
          name: deployer.name,
          healthcheck: `${deployer.name}Check`,
          error_threshold: 0,
          first_byte_timeout: 60000,
          weight: 100,
          connect_timeout: 5000,
          port: 443,
          between_bytes_timeout: 10000,
          shield: '', // 'bwi-va-us',
          max_conn: 200,
          use_ssl: true,
          request_condition: 'false',
        }))
        .map(async (backend) => {
          try {
            return await this._fastly.createBackend(newversion, backend);
          } catch (e) {
            return this._fastly.updateBackend(newversion, backend.name, backend);
          }
        }));

      await this._fastly.writeSnippet(newversion, 'backend', {
        name: 'backend',
        priority: 10,
        dynamic: 0,
        type: 'recv',
        content: this.selectBackendVCL(),
      });

      await this._fastly.writeSnippet(newversion, 'missurl', {
        name: 'missurl',
        priority: 10,
        dynamic: 0,
        type: 'miss',
        content: this.setURLVCL(),
      });

      await this._fastly.writeSnippet(newversion, 'passurl', {
        name: 'passurl',
        priority: 10,
        dynamic: 0,
        type: 'miss',
        content: this.setURLVCL(),
      });

      await this._fastly.writeSnippet(newversion, 'logurl', {
        name: 'logurl',
        priority: 10,
        dynamic: 0,
        type: 'fetch',
        content: `set beresp.http.X-Backend-URL = bereq.url;
        set beresp.http.X-Backend-Name = req.backend;`,
      });
    }, true);
  }
}

module.exports = FastlyGateway;
