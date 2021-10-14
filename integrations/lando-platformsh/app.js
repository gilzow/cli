'use strict';

// Modules
const _ = require('lodash');
const fs = require('fs');
const {getLandoServices} = require('./lib/services');
const mkdirp = require('mkdirp');
const open = require('./lib/open');
const os = require('os');
const path = require('path');
const pshconf = require('./lib/config');
const runconf = require('./lib/run');
const tooling = require('./lib/tooling');
const utils = require('./lib/utils');
const warnings = require('./lib/warnings');

const PlatformshApiClient = require('platformsh-client').default;

// Only do this on platformsh recipes
module.exports = (app, lando) => {
  if (_.get(app, 'config.recipe') === 'platformsh') {
    // Reset the ID if we can
    app.id = _.get(app, 'config.config.id', app.id);
    app.toolingCache = `${app.name}.tooling.cache`;
    app.toolingRouterCache = `${app.name}.tooling.router`;
    app.log.verbose('identified a platformsh app');
    app.log.debug('reset app id to %s', app.id);
    // Sanitize any platformsh auth
    app.log.alsoSanitize('platformsh-auth');
    // the second "app" is variable based on the name of the app in platform
    `app.config.proxy.${app.name}.push('appjs.lndo.site')`;
    // const originalAppName = app._name
    // Explicitly add a path for config and make sure it exists
    app.configPath = path.join(app._config.userConfRoot, 'config', app.name);
    if (!fs.existsSync(app.configPath)) mkdirp.sync(app.configPath);
    app.log.debug(`ensured ${app.configPath} exists`);

    // Start by loading in all the platform files we can
    app.platformsh = {config: pshconf.loadConfigFiles(app.root)};

    // Add in local application overrides as needed
    _.forEach(app.platformsh.config.applications, application => {
      // @NOTE: This remains for backwards compatibility but is deprecated in favor
      // of the the generic case on line 45
      if (_.has(app, `config.config.variables.${application.name}`)) {
        const overrides = _.get(app, `config.config.variables.${application.name}`, {});
        application.variables = _.merge({}, application.variables, overrides);
        app.log.debug('legacy local variable override on %s with %j', application.name, overrides);
      }
      // Handle all local application platform config overrides
      if (_.has(app, `config.config.overrides.${application.name}`)) {
        const overrides = _.get(app, `config.config.overrides.${application.name}`, {});
        _.merge(application, overrides);
        app.log.debug('local override on %s with %j', application.name, overrides);
      }
    });

    // Add in service overrides as needed
    _.forEach(app.platformsh.config.services, (service, name) => {
      if (_.has(app, `config.config.overrides.${name}`)) {
        const overrides = _.get(app, `config.config.overrides.${name}`, {});
        _.merge(service, overrides);
        app.log.debug('local service override on %s with %j', name, overrides);
      }
    });

    // Add in more
    // And then augment with a few other things
    app.platformsh.domain = `${app.name}.${app._config.domain}`;
    app.platformsh.id = app.id;
    app.platformsh.tokenCache = 'platformsh.tokens';
    app.platformsh.tokens = lando.cache.get(app.platformsh.tokenCache) || [];
    app.log.silly('loaded platform config files', app.platformsh);

    /*
     * This event is intended to parse and interpret the platform config files
     * loaded above into things we can use elsewhere, eg if there is any useful
     * non-trivial data mutation that needs to happen ANYWHERE else in the
     * recipe it probably should happen here
     */
    app.events.on('pre-init', 1, () => {
      // Error if we don't have at least one .platform.app.yml
      if (_.isEmpty(app.platformsh.config.applications)) {
        const locations = fs.readdirSync(app.root, {withFileTypes: true})
          .filter(dirent => dirent.isDirectory())
          .map(dirent => ` - ${path.join(app.root, dirent.name, '.platform.app.yaml')}`)
          .concat(path.join(app.root, '.platform', 'applications.yaml'))
          .join(os.EOL);
        lando.log.error(`Could not detect any supported Platform.sh applications in any of: ${os.EOL}${locations}`);
      }

      /*
       * Warn user of unsupported services
       * This event exists to
       */
      app.events.on('post-start', 9, () => {
        // Assess service support and warn for unsupported services
        const allServices = _.map(app.platformsh.services, 'name');
        const supportedServices = _.map(getLandoServices(app.platformsh.services), 'name');
        const unsupportedServices = _.difference(allServices, supportedServices);
        if (!_.isEmpty(unsupportedServices)) {
          const message = _(app.platformsh.services)
            .filter(service => _.includes(unsupportedServices, service.name))
            .map(service => `${service.name} (${service.type})`)
            .value();
          app.addWarning(warnings.unsupportedServices(message.join(', ')));
        }

        // Assess application langauge support and warn for unsupported langauges
        const allApplications = _.map(app.platformsh.applications, 'name');
        const supportedApplications = _.map(getLandoServices(app.platformsh.applications), 'name');
        const unsupportedApplications = _.difference(allApplications, supportedApplications);
        if (!_.isEmpty(unsupportedApplications)) {
          const message = _(app.platformsh.applications)
            .filter(app => _.includes(unsupportedApplications, app.name))
            .map(app => `${app.name} (${app.type})`)
            .value();
          app.addWarning(warnings.unsupportedLanguages(message.join(', ')));
        }
      });

      // Get the platform raw platform config
      const platformConfig = app.platformsh.config;

      // Add the parsed applications config
      app.platformsh.applications = pshconf.parseApps(platformConfig, app.root);
      app.log.verbose('parsed platformsh applications');
      app.log.silly('platformsh applications are', app.platformsh.applications);

      // Find the closest application
      app.platformsh.closestApp = pshconf.findClosestApplication(app.platformsh.applications);
      app.platformsh.closestOpenCache = lando.cache.get(`${app.name}.${app.platformsh.closestApp.name}.open.cache`);
      app.log.verbose('the closest platform app is at %s', app.platformsh.closestApp.configFile);
      app.log.verbose('the closest open cache is %s', app.platformsh.closestOpenCache);

      // console.log('Routes as parsed from yaml:');
      // console.log(platformConfig.routes);

      // Add the parsed routes config

      // this includes all our route data including all, {default}, if applicable has been converted
      // app.platformsh.rawRoutes = pshconf.newParseRoutes(platformConfig.routes, app);
      let rawRoutes = pshconf.newParseRoutes(platformConfig.routes, app);
      app.platformsh.rawRoutes = rawRoutes;
      // console.log('platform routes BEFORE filtering:');
      // console.log(JSON.stringify(rawRoutes, null, 2));
      // @todo move this to an else when we check for the presence of an {all} token
      // strip out the routes we dont need
      app.platformsh.routes = pshconf.filterTokensRedirectsFromRoutes(rawRoutes, app.platformsh.closestApp.name);
      // console.log('platform routes after filtering:');
      // console.log(JSON.stringify(app.platformsh.routes, null, 2));
      // @todo we need to see if we have an {all} token before running
      // @todo we need to see if there's a better way to retrieve the appropriate token
      pshconf.getPlatformDomains(app.platformsh.id, app.platformsh.tokens[0].token, app).then(pshDomains =>{
        // // @todo this works now?!
        // console.log('Our domains from psh at line 149?');
        // console.log(JSON.stringify(pshDomains, null, 2));
        // eslint-disable-next-line max-len
        // app.config.proxy[platformAppName] = pshconf.combineAllProxyDomains(lndoDomain, currentProxies, prxyNoAll, pshDomains);
        if (0 < pshDomains.length) {
          console.log('we have 1 or more domains that need to be added to our rawRoutes');
          let newRoutes = pshconf.buildRoutesFromAttachedDomains(pshDomains, 'app', app._config.domain);
          app.platformsh.rawRoutes = _.merge(rawRoutes, newRoutes);
          // eslint-disable-next-line max-len
          app.platformsh.routes = pshconf.filterTokensRedirectsFromRoutes(app.platformsh.rawRoutes, app.platformsh.closestApp.name);
          console.log('Our complete set of routes:');
          console.log(JSON.stringify(app.platformsh.routes, null, 2));
        } else {
          // console.log('we dont have any attached domains?');
        }
      });

      app.platformsh.primaryRoute = _.findKey(app.platformsh.routes, {default_route: true});

      app.log.verbose('parsed platformsh routes');
      app.log.silly('platformsh routes are', app.platformsh.routes);
      console.log('Routes at line 177 in app.js');
      console.log(JSON.stringify(app.platformsh.routes, null, 2));


      // now that we have the app name, let's set up storage for domains we may have later
      app.config.domains = [];
      app.config.domains[app.platformsh.closestApp.name] = [];
      // now lets handle adding proxy alias domains to lando that the app may need
      app.events.on('post-init', 1, ()=> {
        // console.log('we\'re in post init, do we have our route data still from pre-init?');
        // console.log(JSON.stringify(app.platformsh.routes, null, 2));
         let platformAppName = app.platformsh.closestApp.name;
         const pshApiToken = app.platformsh.tokens[0].token;
         // eslint-disable-next-line no-unused-vars,max-len
         const appProxyAliases = pshconf.getRouteDomains(platformConfig.routes, platformAppName);
         // if we find an index where original_url contains all
         if (0 < appProxyAliases.length) {
           // add the found domains
           app.config.domains[platformAppName] = _.union(app.config.domains[platformAppName], appProxyAliases
             // but we dont want to include {default|all}
             .filter(domain => (-1 === domain.indexOf('{default}') && -1 === domain.indexOf('{all}')))
           );
           // as we add the aliases, make sure we dont have any duplicates
           let currentProxies = app.config.proxy[platformAppName];
           let lndoDomain = app._config.domain;
           let pshProjID = app.platformsh.id;
           if (undefined !== _.find(appProxyAliases, alias => -1 !== alias.indexOf('{all}'))) {
             // console.log('we have at least one route with {all}');
             const prxyNoAll = appProxyAliases.filter(proxy => -1 === proxy.indexOf('{all}'));
             pshconf.getPlatformDomains(pshProjID, pshApiToken, app).then(pshDomains =>{
               // console.log('Our domains from psh at line 224?');
               // console.log(pshDomains);
               // eslint-disable-next-line max-len
               app.config.proxy[platformAppName] = pshconf.combineAllProxyDomains(lndoDomain, currentProxies, prxyNoAll, pshDomains);
               app.config.domains[platformAppName] = _.union(app.config.domains[platformAppName], pshDomains);
             });
           } else {
             // console.log('none of our routes contain {all}');
             // eslint-disable-next-line max-len
             app.config.proxy[platformAppName] = pshconf.combineAllProxyDomains(lndoDomain, currentProxies, appProxyAliases);
           }

           // now update the routes
           // console.log('Our domains before we convert them to routes');
           // console.log(JSON.stringify(app.config.domains[platformAppName], null, 2));
           // eslint-disable-next-line max-len
           // app.platformsh.routes = _.union(app.platformsh.routes, pshconf.buildExtraRoutes(app.config.domains[platformAppName], platformAppName));
           // console.log('Our routes after adding the new ones');
           // console.log(JSON.stringify(app.platformsh.routes, null, 2));
         } else {
           // console.log('No domains to add. Proceeding.');
         }
      });

      // Add relationships keyed by the service name
      app.platformsh.relationships = pshconf.parseRelationships(
        platformConfig.applications,
        app.platformsh.closestOpenCache
      );
      app.log.verbose('determined platformsh relationships');
      app.log.silly('platformsh relationships are', app.platformsh.relationships);

      // Add the parsed services config
      app.platformsh.services = pshconf.parseServices(platformConfig.services, app.platformsh.relationships);
      app.log.verbose('parsed platformsh services');
      app.log.silly('platformsh services ares', app.platformsh.services);

      // Figure out what relationships are pullable and not
      app.platformsh.closestApp.syncableRelationships = pshconf.getSyncableRelationships(
        app.platformsh.closestApp.relationships,
        app.platformsh.services
      );

      console.log('this is right before we send the info for the container env vars to be set. line 250 in app.js');
      console.log(JSON.stringify(app.platformsh.routes, null, 2));
      // Go through our platform config and generate an array of configuration files for each
      // container so we can inject /run/config.json
      // @todo THIS IS WHERE THE ROUTES GET INJECTED INTO THE CONTAINER!!!
      app.platformsh.runConfig = runconf.buildRunConfig(app);
      app.log.verbose('built platformsh config jsons');
      app.log.silly('generated platformsh runtime config is', app.platformsh.runConfig);
    });

    /*
     * This event is intended to make sure we reset the active token and cache when it is passed in
     * via the lando pull or lando push commands
     */
    _.forEach(['pull', 'push'], command => {
      app.events.on(`post-${command}`, (config, answers) => {
        // Only run if answer.auth is set, this allows these commands to all be
        // overriden without causing a failure here
        if (answers.auth) {
          const api = new PlatformshApiClient({api_token: answers.auth});
          return api.getAccountInfo().then(me => {
            // This is a good token, lets update our cache
            const cache = {token: answers.auth, email: me.mail, date: _.toInteger(_.now() / 1000)};
            // Update lando's store of platformsh machine tokens
            const tokens = lando.cache.get(app.platformsh.tokenCache) || [];
            lando.cache.set(app.platformsh.tokenCache, utils.sortTokens(tokens, [cache]), {persist: true});
            // Update app metdata
            const metaData = lando.cache.get(`${app.name}.meta.cache`);
            lando.cache.set(`${app.name}.meta.cache`, _.merge({}, metaData, cache), {persist: true});
          });
        }
      });
    });

    /*
     * This event makes sure we refresh the config we inject into /run/config.json when a first
     * start/rebuild happens
     */
    app.events.on('post-init', () => {
      app.events.on('pre-start', 1, () => {
        if (!lando.cache.get(app.preLockfile)) {
          _.forEach(app.platformsh.runConfig, service => {
            fs.writeFileSync(service.file, JSON.stringify(service.data));
            app.log.debug(`dumped platform config file for ${service.service} to ${service.file}`);
          });
        }
      });
    });

    /*
     * This event makes sure we collect any information that is only available once the service is on
     * like the IP address, we use docker inspect under the hood
     */
    app.events.on('post-init', () => {
      // Get service containers
      const services = utils.getNonApplicationServices(app.config.services);
      app.events.on('post-start', 1, () => lando.Promise.resolve(services)
      .map(service => app.engine.scan({id: `${app.project}_${service.name}_1`}).then(data => {
        // Find the config for this service
        const serviceConfig = _.find(app.config.services, {name: service.name});
        // Add some helpful things to augment our applicaiton OPENER
        // @TODO: is this a good list?
        serviceConfig.platformsh.openMerge = {
          cluster: 'bespin',
          fragment: null,
          hostname: `${app.name}.${serviceConfig.name}.service._.lndo.site`,
          ip: open.getIPAddress(data, `${app.project}_default`),
          rel: serviceConfig.name,
          service: serviceConfig.name,
          type: [serviceConfig.platformsh.type, serviceConfig.version].join(':'),
        };
      })));
    });

    /*
     * This event makes user of the new tooling.router so that we can load the correct tooling
     * based on the closest route
     */
    app.events.on('post-init', 9, () => {
      // Get global tooling commands
      const globalTooling = _.pick(app.config.tooling, ['pull', 'push']);
      // Build the tooling router
      const toolingRouter = _(app.config.services)
        // Filter out non platform services
        .filter(service => _.has(service, 'platformsh'))
        // Filter out non application containers
        .filter(service => service.platformsh.application)
        // Get the application tooling
        .map(application => ({
          route: application.platformsh.appMountDir,
          appTooling: tooling.getAppTooling(application),
          openData: lando.cache.get(`${app.name}.${application.name}.open.cache`),
        }))
        // Get the services containers
        .map(application => _.merge({}, application, {
          serviceContainers: _(app.config.services)
            .filter(service => _.includes(tooling.getRelatableServices(application.openData), service.name))
            .map(service => service)
            .value(),
        }))
        // Get the service tooling
        .map(application => _.merge({}, application, {
          serviceTooling: tooling.getServiceTooling(
            application.serviceContainers,
            application.openData,
            application.name
          ),
        }))
        // Merge it all together
        .map(application => ({
          route: application.route,
          tooling: _.merge({}, globalTooling, application.appTooling, application.serviceTooling),
        }))
        // Return
        .value();

      // If we dont have a route for app.root then add in the closest app
      if (!_.includes(_.map(toolingRouter, 'route'), app.root)) {
        if (_.has(app, 'platformsh.closestApp.appMountDir')) {
          const closestMountDir = app.platformsh.closestApp.appMountDir;
          const closestRoute = _.cloneDeep(_.find(toolingRouter, route => route.route === closestMountDir));
          closestRoute.route = app.root;
          toolingRouter.unshift(closestRoute);
        }
      }

      // Dump the tooling router
      lando.cache.set(app.toolingRouterCache, JSON.stringify(toolingRouter), {persist: true});
    });

    // Remove tooling router on uninstall
    app.events.on('post-uninstall', () => {
      app.log.verbose('removing tooling router...');
      lando.cache.remove(app.toolingRouterCache);
    });

    /*
     * This event handles the platform OPEN lifecycle event. This collects information we get on stdout
     * when we run /etc/platform/commands/open on non-application conatiners, parses it, mixes in other information
     * we got previously like the IP address and then uses that to do the same open command on each application
     * container
     *
     * This is required to expose the application container to the world, eg it starts up nginx/fpm on exposed ports
     * and to set the PLATFORM_RELATIONSHIPS envvar.
     */
    app.events.on('post-init', () => {
      // Get lists of application and services
      const services = utils.getNonApplicationServices(app.config.services);
      const appservers = utils.getApplicationServices(app.config.services);
      app.log.verbose('preparing to OPEN up platformsh containers...');
      app.log.debug('found platformsh services to open', _.map(services, 'name'));
      app.log.debug('found platformsh appservers to open', _.map(appservers, 'name'));

      // Open up services and collect their output
      app.events.on('post-start', 8, () => {
        // Note this may take a bit
        console.log('Opening platform.sh containers... this may take a bit...');

        // Open everything
        return lando.Promise.map(services, service => lando.Promise.retry(() => lando.engine.run({
           id: `${app.project}_${service.name}_1`,
           cmd: ['/helpers/psh-open.sh', service.platformsh.opener],
           compose: app.compose,
           project: app.project,
           opts: {
             mode: 'attach',
             services: [service.name],
             user: 'root',
             noTTY: true,
             cstdio: ['ignore', 'pipe', 'ignore'],
             silent: true,
           },
        }))
        // Modify the data a bit so we can inject it better
        .then(data => {
          try {
            // Try to get the data
            const parsedData = open.parseOpenData(data);
            // Merge in other open data
            _.forEach(parsedData, endpoint => _.merge(endpoint, service.platformsh.openMerge));
            // And return
            return [service.name, parsedData];
          // TODO: We probably need a better error message, fallback, etc here
          } catch (e) {
            app.log.error('could not parse json', e, data);
            return;
          }
        }))
        // Inject it into each appserver
        .then(data => {
          // Mutate the data into something easier to use
          const serviceData = _.fromPairs(data);
          app.log.debug('collected open data from platform services', serviceData);

          // Open all the appservers
          return lando.Promise.map(appservers, appserver => {
            const relationships = open.parseRelationships(appserver.platformsh.relationships);
            const openPayload = open.generateOpenPayload(serviceData, relationships);
            const openCache = `${app.name}.${appserver.name}.open.cache`;
            app.log.verbose(`${appserver} has relationship config`, relationships);
            app.log.verbose(`generated open payload for ${appserver.name}`, openPayload);
            lando.cache.set(openCache, openPayload, {persist: true});
            app.log.debug(`cached open payload data to ${openCache}`);

            // OPEN
            return lando.engine.run({
              id: `${app.project}_${appserver.name}_1`,
              cmd: ['/helpers/psh-open.sh', JSON.stringify({relationships: openPayload})],
              compose: app.compose,
              project: app.project,
              opts: {
                hijack: false,
                services: [appserver.name],
                user: 'root',
                cstdio: ['inherit', 'pipe', 'pipe'],
                silent: true,
              },
            });
          });
        });
      });
    });
  }
};
