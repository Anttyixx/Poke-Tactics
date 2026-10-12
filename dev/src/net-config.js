// Relay (TURN) server for online play. Two players on different networks can
// often connect directly, but many home routers and mobile carriers block that;
// then the connection has to go through a relay. Game messages are tiny, so a
// free relay plan is plenty.
//
// Metered.ca: in the TURN Server dashboard, "New credential" gives a username
// and password for its relay servers. They're kept out of the repo: the deploy
// workflow fills them in from the METERED_TURN_USERNAME and
// METERED_TURN_PASSWORD repository secrets. (Browsers have to see them to use
// the relay, so they're visible on the live site; that's normal for TURN.)
// Without them, online play still works whenever players can connect directly.
export const TURN_URLS = [
  'turn:global.relay.metered.ca:80',
  'turn:global.relay.metered.ca:80?transport=tcp',
  'turn:global.relay.metered.ca:443',
  'turns:global.relay.metered.ca:443?transport=tcp',
];
export const TURN_USERNAME = '67f5e2f41dfc0c7e1e42261b'; // set at deploy time
export const TURN_PASSWORD = 'XgsBM1AasfntJblp'; // set at deploy time
