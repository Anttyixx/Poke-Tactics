// Relay (TURN) server for online play. Two players on different networks can
// often connect directly, but many home routers and mobile carriers block that;
// then the connection has to go through a relay. Game messages are tiny, so a
// free relay plan is plenty.
//
// Metered.ca (free plan): the app name is the part before .metered.live. The
// API key (a publishable one; restrict it to this site's domain in the Metered
// dashboard) is kept out of the repo: the deploy workflow fills it in from the
// METERED_API_KEY repository secret. Without it, online play still works
// whenever the players can connect directly.
export const METERED_APP = 'poke-tactics';
export const METERED_API_KEY = 'pk_live_d61a3fb98d891151cd0a6e22e4e5e2c10a846cb4'; // set at deploy time
