// Relay (TURN) server for online play. Two players on different networks can
// often connect directly, but many home routers and mobile carriers block that;
// then the connection has to go through a relay. Game messages are tiny, so a
// free relay plan is plenty.
//
// Metered.ca (free plan): sign up, create a TURN app, and copy its app name
// (the part before .metered.live) and an API key here. In the Metered
// dashboard, restrict the key to this site's domain.
export const METERED_APP = '';
export const METERED_API_KEY = '';
