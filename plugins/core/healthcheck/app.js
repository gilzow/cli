'use strict';

// Modules
const _ = require('lodash');
const warnings = require('./lib/warnings');

module.exports = (app, lando) => {
  // Find all services with healthchecks and them to the app info
  // @TODO make sure this is overrideable
  app.events.on('post-init', () => {
    _.forEach(app.info, service => {
      const hasHealthcheck = _.has(_.find(lando.factory.get(), {name: service.type}), 'config.healthcheck');
      if (hasHealthcheck) service.healthcheck = _.find(lando.factory.get(), {name: service.type}).config.healthcheck;
    });
  });

  // Add some logic that extends start until healthchecked containers report as healthy
  app.events.on('post-start', 1, () => lando.engine.list({project: app.project})
    // Filter out containers without a healthcheck
    .filter(container => _.has(_.find(app.info, {service: container.service}), 'healthcheck'))
    // Map to info
    .map(container => _.find(app.info, {service: container.service}))
    // Map to a retry of the healthcheck command
    .map(info => lando.Promise.retry(() => {
      return app.engine.run({
        id: `${app.project}_${info.service}_1`,
        cmd: info.healthcheck,
        compose: app.compose,
        project: app.project,
        opts: {
          user: 'root',
          cstdio: 'pipe',
          silent: true,
          noTTY: true,
          services: [info.service],
        },
      })
      .catch(err => {
        console.log('Waiting until %s service is ready...', info.service);
        app.log.debug('running healthcheck %s for %s...', info.healthcheck, info.service);
        // app.log.silly(err);
        return Promise.reject(info.service);
      });
    }, {max: 25, backoff: 1000})
    .catch(service => {
      info.healthy = false;
      app.addWarning(warnings.serviceUnhealthyWarning(service), Error(`${service} reported as unhealthy.`));
    })));
};
