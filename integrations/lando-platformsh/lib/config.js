'use strict';

// Modules
const _ = require('lodash');
const fs = require('fs');
const path = require('path');
const PlatformYaml = require('./yaml');
const utils = require('./utils');
const PlatformshApiClient = require('platformsh-client').default;
/*
 * Helper to get appMount
 */
const getAppMount = (app, base, files) => {
  if (_.has(app, 'source.root')) return path.join(base, app.source.root);
  return _(files)
    .filter(file => file.name === app.name)
    .thru(file => file[0].dir)
    .value();
};

/*
 * Helper to locate the "closest" platform yaml
 */
const traverseUp = (startFrom = process.cwd()) => {
  return _(_.range(path.dirname(startFrom).split(path.sep).length))
    .map(end => _.dropRight(path.dirname(startFrom).split(path.sep), end).join(path.sep))
    .unshift(startFrom)
    .dropRight()
    .value();
};

/*
 * Helper to parse service relationships
 */
const parseServiceRelationships = ({relationships = {}}) => {
  // This is most things
  if (_.isEmpty(relationships)) return {};

  // Otherwise
  return _(relationships)
    .map((config, name) => ([name, [{
      service: config.split(':')[0],
      host: config.split(':')[0],
      port: 80,
    }]]))
    .fromPairs()
    .value();
};

/*
 * Helper to replace defaualt
 */
const replaceDefault = (data, replacer) => {
  if (_.isObject(data)) {
    return JSON.parse(JSON.stringify(data).replace(/{default}/g, replacer));
  } else {
    return data.replace(/{default}/g, replacer);
  }
};

// const expandAll =

/*
 * Helper to set primary route if needed
 */
const setPrimaryRoute = (routes = {}) => {
  // If we dont have a primary then set one
  if (!_.isEmpty(routes) && !_.some(routes, 'primary')) {
    const firstUpstream = _.find(routes, {type: 'upstream'});
    firstUpstream.primary = true;
  }

  // Return
  return routes;
};

/**
 * Extracts the domain (e.g. foo.com) from the URL and combines it with the lando domain (e.g. lndo.site)
 * @param {string} route the full url as parsed from routes.yaml
 * @param {string} landoDomain the lando local "TLD" from configuration
 * @return {string} the extracted domain
 */
const createLandoDomain = (route, landoDomain) => {
  const findDomain = new RegExp('https?:\\/\\/([^\\/]+)\\/?');
  let adjustedDomain = '';
  if (findDomain.test(route)) {
    // does the first array part from a regex exec not contained the matched capture group?
    // nope, it doesnt. 0 is the full match, 1 is the capture group
    // console.log('our matches from regex');
    // console.log(JSON.stringify(findDomain.exec(route)));
    // @todo I dont like assuming that our domain is in the 1 index
    adjustedDomain = _.nth(findDomain.exec(route), 1) + '.' + landoDomain;
  }

  return adjustedDomain;
};

/*
 * Helper to find closest app
 */
exports.findClosestApplication = (apps = []) => _(apps)
  .filter(app => app.closeness !== -1)
  .orderBy('closeness')
  // @NOTE: If there is not a "closest" app then just choose the first one that
  // shows up so that an error is prevented
  .thru(appsByCloseness => {
    if (!_.isEmpty(appsByCloseness)) return appsByCloseness[0];
    else return apps[0];
  })
  .value();

/*
 * Helper to filter relations
 */
exports.getSyncableRelationships = (relationships = {}, services = []) => _(relationships)
  // Arrayify
  .toPairs()
  // Break it up and augment a bit
  .map(data => ({key: data[0], value: data[1], service: _.first(data[1].split(':'))}))
  // Add in the service type
  .map(data => _.merge(data, _.find(services, {name: data.service})))
  // Break up type
  .map(data => _.merge(data, {type: _.first(data.type.split(':')), version: _.last(data.type.split(':'))}))
  // Filter out unsupported syncable services
  // @NOTE: use an external list if needed at some points
  .filter(data => _.includes(['mariadb', 'mysql', 'postgresql'], data.type))
  // Reconstruct
  .map(data => ([data.key, data.value]))
  .fromPairs()
  .value();

/*
 * Helper to load all the platform config files we can find
 */
exports.loadConfigFiles = baseDir => {
  const yamlPlatform = new PlatformYaml();
  const routesFile = path.join(baseDir, '.platform', 'routes.yaml');
  const servicesFile = path.join(baseDir, '.platform', 'services.yaml');
  const applicationsFile = path.join(baseDir, '.platform', 'applications.yaml');
  const platformAppYamls = _(fs.readdirSync(baseDir, {withFileTypes: true}))
    .filter(dirent => dirent.isDirectory())
    .map(dirent => dirent.name)
    .concat('.')
    .map(directory => path.resolve(baseDir, directory, '.platform.app.yaml'))
    .filter(file => fs.existsSync(file))
    .map(file => ({data: yamlPlatform.load(file), file}))
    .map(data => ({name: data.data.name, file: data.file, dir: path.dirname(data.file)}))
    .value() || [];

  // Load in applications from all our platform yamls
  const applications = _(platformAppYamls)
    .map(app => yamlPlatform.load(app.file))
    .value() || [];

  // If we also have an applications file then concat
  if (fs.existsSync(applicationsFile)) {
    applications.push(yamlPlatform.load(applicationsFile));
  }

  return {
    applications: _.flatten(applications),
    applicationFiles: platformAppYamls,
    routes: (fs.existsSync(routesFile)) ? yamlPlatform.load(routesFile) : {},
    services: (fs.existsSync(servicesFile)) ? yamlPlatform.load(servicesFile) : {},
  };
};

/*
 * Helper to parse the platformsh config files
 */
exports.parseApps = ({applications, applicationFiles}, appRoot) => _(applications)
  // Get the basics
  .map(app => _.merge({}, app, {
    application: true,
    appMountDir: getAppMount(app, appRoot, applicationFiles),
    closeness: _.indexOf(traverseUp(), getAppMount(app, appRoot, applicationFiles)),
    // @TODO: can we assume the 0? is this an index value?
    // @NOTE: probably not relevant until we officially support multiapp?
    hostname: `${app.name}.0`,
    sourceDir: _.has(app, 'source.root') ? path.join('/app', app.source.root) : '/app',
    webroot: utils.getDocRoot(app),
  }))
  // And the webPrefix
  .map(app => _.merge({}, app, {
    webPrefix: _.difference(app.appMountDir.split(path.sep), appRoot.split(path.sep)).join(path.sep),
  }))
  // Return
  .value();

/*
 * Helper to parse the platformsh config files
 */
exports.parseRelationships = (apps, open = {}) => _(apps)
  .map(app => app.relationships || [])
  .flatten()
  .thru(relationships => relationships[0])
  .map((relationship, alias) => ({
    alias,
    service: relationship.split(':')[0],
    endpoint: relationship.split(':')[1],
    creds: _.get(open, alias, {}),
  }))
  .groupBy('service')
  .value();

/*
 * Helper to parse the platformsh routes file eg replace DEFAULT in the routes.yml
 */
exports.parseRoutes = (routes, domain) => _(routes)
  // Add implicit data and defaults
  .map((config, url) => ([url, _.merge({primary: false, attributes: {}, id: null, original_url: url}, config)]))
  // .tap(function(route){
  //   console.log('Contents of route at line 190 in config.js');
  //   console.log(JSON.stringify(route, null, 2));
  // })
  // Filter out FQDNs because they are going to point to a prod site
  // NOTE: do we want to make the above configurable?
  .filter(route => _.includes(route[0], '{default}'))
  // Replace URL defaults
  .map(route => ([replaceDefault(route[0], domain), route[1]]))
  // .map(route => ([expandAll(route[0], domain, route[1])]))
  // Replace config defaults
  .map(route => ([route[0], _.merge(route[1], replaceDefault(_.omit(route[1], ['original_url']), domain))]))
  // Strip upstream if needed
  .map(route => {
    if (route[1].upstream) route[1].upstream = _.first(route[1].upstream.split(':'));
    return [route[0], route[1]];
  })

  // Back to object
  .fromPairs()
  // Set the primary route
  .thru(routes => setPrimaryRoute(routes))
  // Return
  .value();

/**
 * Converts the list of routes from routes.yaml into "local" domains to be added as proxy aliases
 * @param {object} routes list of routes from the parsed routes.yaml file
 * @param {string} appname the name of the "app" as defined in .platform.app.yaml
 * @param {string} appDomain the local lando "tld" as defined in configuration
 * @param {string} pshApiToken Platform.sh API token so we can connect
 * @param {string} projectID Platform.sh Project ID
 * @return {array} list of proxy aliases domains
 */
exports.getRouteDomains = (routes, appname, appDomain, pshApiToken, projectID) => _(routes)
  .thru(routes => {
    // console.log('Our routes inside our new function to retrieve domains. line 218 of psh recipe config.js');
    // console.log(JSON.stringify(routes, null, 2));
    // console.log('Our appname inside our new function to retrieve domains. line 220 of psh recipe config.js');
    // console.log(JSON.stringify(appname));
    // console.log('Our appDomain inside our new function to retrieve domains. line 218 of psh recipe config.js');
    // console.log(JSON.stringify(appDomain));
    return routes;
  })
  .map((data, url) => {
    return _.merge({original_url: url}, data);
  })
  // we only want the ones that are upstreams
  .filter(route => route.type === 'upstream')
  .thru(routes => {
    console.log('our routes after we do the first filter.');
    console.log(JSON.stringify(routes, null, 2));
    return routes;
  })
  // we only want the upstreams that match our app name
  .filter(route => {
    let parts = route.upstream.split(':');
    // console.log('our upstream split into pieces');
    // console.log(JSON.stringify(parts, null, 2));
    let appPart = _.first(parts);
    // console.log('the first bit of our broken up upstream');
    // console.log(JSON.stringify(appPart, null, 2));
    // console.log('the upstream app we\'re trying to match');
    // console.log(JSON.stringify(appname, null, 2));
    let boolApp = (appname === appPart);
    // console.log('the boolean we\'ll return for whether this belong to our  upstream app');
    // console.log(JSON.stringify(boolApp, null, 2));
    return boolApp;
  })
  // @todo refactor down to one line
  .filter( route => {
    // console.log('The URL is :');
    // console.log(JSON.stringify(route.original_url));
    let boolURL = (_.includes(route.original_url, '{default}'));
    // console.log('Does our URL contain {default}?');
    // console.log(JSON.stringify(boolURL));
    // console.log('going to return the following for the filter');
    // console.log(JSON.stringify(!boolURL));
    return !boolURL;
  })
  // .thru(routes => {
  //   console.log('our routes after we do the THIRD filter.');
  //   console.log(JSON.stringify(routes, null, 2));
  //   return routes;
  // })
  .map(route => {
    if (-1 !== route.original_url.indexOf('{all}')) {
      console.log('we have a route that contains {all} so we need to go get all the attached platform domains.');
      console.log('Do we have our api token? ');
      console.log(JSON.stringify(pshApiToken));
      console.log('And what about our project ID? ');
      console.log(JSON.stringify(projectID));
      // @todo we need to retrieve the list of domains from the platform project, and for each one, add them as an entry
      // in the list of domains to create aliases EXCEPT for the default domain, which we need to simply recreate as the
      // the default lando.site domain
      // const pshApi = new PlatformshApiClient({api_token: pshApiToken});
      // return pshApi.getProject(projectID).then(project => {
      //   return project.getDomains().then(domains => {
      //     domains.map(domain => domain.name);
      //     console.log('Our project domains?');
      //     console.log(JSON.stringify(domains, null, 2));
      //     return domains;
      //   });
      // });
    }
    return route;
  })

  .flatten()
  .map(route => createLandoDomain(route.original_url, appDomain))
  // .thru(routes => {
  //   console.log('our routes after we convert the domains?.');
  //   console.log(JSON.stringify(routes, null, 2));
  //   return routes;
  // })
  .value();

/*
 * Helper to parse the platformsh services file
 */
exports.parseServices = (services, relationships = {}) => _(services)
  .map((config, name) => _.merge({}, config, {
    aliases: _.has(relationships, name) ? _.map(relationships[name], 'alias') : [],
    application: false,
    creds: _(_.get(relationships, name, {}))
      .map('creds')
      .flatten()
      .value(),
    hostname: name,
    name,
    opener: JSON.stringify({relationships: parseServiceRelationships(config)}),
  }))
  .value();
