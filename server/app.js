/*******************************************************
The predix-webapp-starter Express web application includes these features:
  * routes to mock data files to demonstrate the UI
  * passport-predix-oauth for authentication, and a sample secure route
  * a proxy module for calling Predix services such as asset and time series
*******************************************************/
var http = require('http'); // needed to integrate with ws package for mock web socket server.
var express = require('express');
var jsonServer = require('json-server'); // used for mock api responses
var path = require('path');
var cookieParser = require('cookie-parser'); // used for session cookie
var bodyParser = require('body-parser');
var passport;  // only used if you have configured properties for UAA
var session = require('express-session');
var proxy = require('./routes/proxy'); // used when requesting data from real services.
// get config settings from local file or VCAPS env var in the cloud
var config = require('./predix-config');
// configure passport for authentication with UAA
var passportConfig = require('./passport-config');
// getting user information from UAA
var userInfo = require('./routes/user-info');
var app = express();
var httpServer = http.createServer(app);

/**********************************************************************
       SETTING UP EXRESS SERVER
***********************************************************************/
app.set('trust proxy', 1);

// if running locally, we need to set up the proxy from local config file:
var node_env = process.env.node_env || 'development';
console.log('************ Environment: '+node_env+'******************');

if (node_env === 'development') {
  var devConfig = require('./localConfig.json')[node_env];
	proxy.setServiceConfig(config.buildVcapObjectFromLocalConfig(devConfig));
	proxy.setUaaConfig(devConfig);
} else {
  app.use(require('compression')()) // gzip compression
}

// Session Storage Configuration:
// *** Use this in-memory session store for development only. Use redis for prod. **
var sessionOptions = {
  secret: 'predixsample',
  name: 'cookie_name', // give a custom name for your cookie here
  maxAge: 30 * 60 * 1000,  // expire token after 30 min.
  proxy: true,
  resave: true,
  saveUninitialized: true
  // cookie: {secure: true} // secure cookie is preferred, but not possible in some clouds.
};
var redisCreds = config.getRedisCredentials();
if (redisCreds) {
  console.log('Using Redis for session store.');
  var RedisStore = require('connect-redis')(session);
  sessionOptions.store = new RedisStore({
    host: redisCreds.host,
    port: redisCreds.port,
    pass: redisCreds.password,
    ttl: 1800 // seconds = 30 min
  });
}
app.use(cookieParser('predixsample'));
app.use(session(sessionOptions));

console.log('UAA is configured?', config.isUaaConfigured());
if (config.isUaaConfigured()) {
	passport = passportConfig.configurePassportStrategy(config);
  app.use(passport.initialize());
  // Also use passport.session() middleware, to support persistent login sessions (recommended).
  app.use(passport.session());
}
app.use(bodyParser.json());
app.use(bodyParser.urlencoded({ extended: false }));

/****************************************************************************
	SET UP EXPRESS ROUTES
*****************************************************************************/

// app.get('/docs', require('./routes/docs')(config));

if (!config.isUaaConfigured()) { 
  // no restrictions
  app.use(express.static(path.join(__dirname, process.env['base-dir'] ? process.env['base-dir'] : '../public')));

  // mock UAA routes
  app.get(['/login', '/logout'], function(req, res) {
    res.redirect('/');
  })
  app.get('/userinfo', function(req, res) {
      res.send({user_name: 'Sample User'});
  });
} else {
  //login route redirect to predix uaa login page
  app.get('/login',passport.authenticate('predix', {'scope': ''}), function() {
    // The request will be redirected to Predix for authentication, so this
    // function will not be called.
  });

  // route to fetch user info from UAA for use in the browser
  app.get('/userinfo', userInfo(config.uaaURL), function(req, res) {
    res.send(req.user.details);
  });

  //callback route redirects to secure route after login
  app.get('/callback', passport.authenticate('predix', {
  	failureRedirect: '/'
  }), function(req, res) {
    console.log('in /callback route.');
    console.log('session ID: ', req.sessionID);
    if (req.session.deviceUrl) {
      var url = req.session.deviceUrl;
      req.session.deviceUrl = null;
      console.log('/callback route. redirecting to: ', url);
      // we can't pass headers thru redirect, so we have to use query string. :(
      res.redirect(url + '?pk=' + req.sessionID);
    } else {
      console.log('/callback route. redirecting to: /');
      res.redirect('/');
    }
  });

  // example of calling a custom microservice.
  // if (windServiceURL && windServiceURL.indexOf('https') === 0) {
  //   app.get('/windy/*', passport.authenticate('main', { noredirect: true}),
  //     // if calling a secure microservice, you can use this middleware to add a client token.
  //     // proxy.addClientTokenMiddleware,
  //     proxy.customProxyMiddleware('/windy', windServiceURL)
  //   );
  // }

  // if (config.rmdDatasourceURL && config.rmdDatasourceURL.indexOf('https') === 0) {
  //   app.get('/api/datagrid/*', 
  //       proxy.addClientTokenMiddleware, 
  //       proxy.customProxyMiddleware('/api/datagrid', config.rmdDatasourceURL, '/services/experience/datasource/datagrid'));
  // }


  // We need this to be registered before the '/' route.
  app.get('/device-login', 
    function(req, res, next) {
      console.log('cloudlogin, before auth.  deviceUrl from query:', req.query.deviceUrl);      
      req.session.deviceUrl = req.query.deviceUrl;
      console.log('cloudlogin, sessionID:', req.sessionID);
      next();
    },
    passport.authenticate('main', {
      noredirect: false
    }) 
  );

  // route to get all devices for a user from kit-service.  needs a user token.
  app.get('/api/kit/device',
      passport.authenticate('main', {
      noredirect: false
    }),
    function(req, res, next) {
      // add token to request
      if (req.session 
          && req.session.passport 
          && req.session.passport.user 
          && req.session.passport.user.ticket
          && req.session.passport.user.ticket.access_token) {
        req.headers['Authorization'] = 'bearer ' + req.session.passport.user.ticket.access_token;   
        next();       
      } else {
        res.status(401).send({error: "Session expired, or no token found in session."})
      }      
    },
    proxy.customProxyMiddleware('/api/kit/device', config.kitServiceURL, '/device/')
  );

  // TODO: get kit service URL from config
  // if (config.kitServiceURL && config.kitServiceURL.indexOf('https') === 0) {
    app.post('/api/kit/register',

        function(req, res, next) {
          console.log('in /api/kit/* route.'); 
          // console.log('req.query.cloudSession', req.query.cloudSession);
          console.log('req.body', req.body);
          console.log('req.body.pk', req.body.pk);
          sessionOptions.store.get(req.body.pk, function(err, session) {
            if (err) {
         			res.status(err.status || 500);
              res.send({
                message: err.message,
                error: err
              });
            }
            console.log('session pulled from store by id:', JSON.stringify(session));
            // add token to request
            if (session 
                && session.passport 
                && session.passport.user 
                && session.passport.user.ticket
                && session.passport.user.ticket.access_token) {
              req.headers['Authorization'] = 'bearer ' + session.passport.user.ticket.access_token;   
              next();       
            } else {
              console.log('session:', session);
              console.warn('*** No token found in session.')
              // res.redirect('/device-login');
              res.status(401).send({error: "Session expired, or no token found in session."})
            }
            // next();
          });
          // console.log('entire session: ', JSON.stringify(req.session));
          // sessionOptions.store.ids(function(err, keys) {
          //   console.log('session count: ', JSON.stringify(keys));
          // });      
        },

        proxy.customProxyMiddleware('/api/kit/register', config.kitServiceURL, '/device/register')
    );  

  // access real Predix services using this route.
  // the proxy will add UAA token and Predix Zone ID.
  // (this route must be register after /api/kit/register, since that route is not protected by passport authentication.)
  app.use(['/predix-api', '/api'],
  	passport.authenticate('main', {
  		noredirect: true
  	}),
  	proxy.router);

  //Use this route to make the entire app secure.  This forces login for any path in the entire app.
  app.use('/', 
    passport.authenticate('main', {
      noredirect: false //Don't redirect a user to the authentication page, just show an error
    }),
    express.static(path.join(__dirname, process.env['base-dir'] ? process.env['base-dir'] : '../public'))
  );

}

/*******************************************************
SET UP MOCK API ROUTES
*******************************************************/
// NOTE: these routes are added after the real API routes. 
//  So, if you have configured asset, the real asset API will be used, not the mock API.
// Import route modules
var mockAssetRoutes = require('./routes/mock-asset.js')();
var mockTimeSeriesRouter = require('./routes/mock-time-series.js');
var mockKitRoutes = require('./routes/mock-kit.js')();
// add mock API routes.  (Remove these before deploying to production.)
app.use(['/mock-api/predix-asset', '/api/predix-asset'], jsonServer.router(mockAssetRoutes));
app.use(['/mock-api/predix-timeseries', '/api/predix-timeseries'], mockTimeSeriesRouter);
app.use('/api/kit', jsonServer.router(mockKitRoutes));
require('./routes/mock-live-data.js')(httpServer);
// ***** END MOCK ROUTES *****

// route to return info for path-guide component.
app.use('/learningpaths', require('./routes/learning-paths')(config));

//logout route
app.get('/logout', function(req, res) {
	req.session.destroy();
	req.logout();
  passportConfig.reset(); //reset auth tokens
  res.redirect(config.uaaURL + '/logout?redirect=' + config.appURL);
});

app.get('/favicon.ico', function (req, res) {
	res.send('favicon.ico');
});

app.get('/config', function(req, res) {
  let title = "Predix Kit Sensors";
  res.send({wsUrl: config.websocketServerURL, appHeader: title});
});

// Sample route middleware to ensure user is authenticated.
//   Use this route middleware on any resource that needs to be protected.  If
//   the request is authenticated (typically via a persistent login session),
//   the request will proceed.  Otherwise, the user will be redirected to the
//   login page.
//currently not being used as we are using passport-oauth2-middleware to check if
//token has expired
/*
function ensureAuthenticated(req, res, next) {
    if(req.isAuthenticated()) {
        return next();
    }
    res.redirect('/');
}
*/

////// error handlers //////
// catch 401 and redirect to login
// app.use(function(req, res) {
//   console.log('status code:', res.statusCode);
//   if (res.statusCode === 401) {
//     console.log('redirecting to /login');
//     res.redirect('/login');
//   }
// });

// catch 404 and forward to error handler
app.use(function(err, req, res, next) {
  console.error(err.stack);
	var err = new Error('Not Found');
	err.status = 404;
	next(err);
});

// development error handler - prints stacktrace
if (node_env === 'development') {
	app.use(function(err, req, res, next) {
		if (!res.headersSent) {
			res.status(err.status || 500);
			res.send({
				message: err.message,
				error: err
			});
		}
	});
}

// production error handler
// no stacktraces leaked to user
app.use(function(err, req, res, next) {
	if (!res.headersSent) {
		res.status(err.status || 500);
		res.send({
			message: err.message,
			error: {}
		});
	}
});

httpServer.listen(process.env.VCAP_APP_PORT || 5000, function () {
	console.log ('Server started on port: ' + httpServer.address().port);
});

module.exports = app;