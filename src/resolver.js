/**
 * Group Resolver
 * 
 * Determines which logical group a user belongs to by trying strategies
 * in order until one succeeds.
 * 
 * Strategies:
 *   api_group    - Looks up cached user group membership (primary).
 *                  Cache is built by UniFiClient.syncUserGroups() which
 *                  iterates all user groups and fetches members via
 *                  GET /user_groups/:id/users/all
 * 
 *   manual       - Checks config.resolver.manual_overrides for a
 *                  userId -> group mapping. Useful for edge cases or
 *                  users not in any UniFi group.
 * 
 *   policy_name  - Would use policy_name from webhook payload, but the
 *                  official API reference (section 11.7) confirms this
 *                  field is always an empty string. Kept as a strategy
 *                  in case Ubiquiti populates it in a future firmware.
 */

const logger = require('./logger');

class Resolver {
  constructor(config, unifiClient) {
    this.strategies = config.resolver?.strategy_order || ['api_group', 'manual'];
    this.policyToGroup = config.resolver?.policy_to_group || {};
    this.manualOverrides = config.resolver?.manual_overrides || {};
    this.unifiClient = unifiClient;
  }

  /**
   * Resolve a user's logical group name.
   * 
   * @param {string} userId - User ID from webhook actor.id field
   * @param {object} webhookObject - The "object" section of the webhook payload
   *                                 (contains policy_id, policy_name, etc.)
   * @returns {{ group: string|null, strategy: string|null, userName: string|null }}
   */
  resolve(userId, webhookObject = {}) {
    if (!userId) {
      logger.debug('Resolver: no userId provided');
      return { group: null, strategy: null, userName: null };
    }

    const userName = this.unifiClient.getUserName(userId) || null;

    for (const strategy of this.strategies) {
      let group = null;

      switch (strategy) {
        case 'api_group':
          group = this.unifiClient.getGroupForUser(userId);
          break;

        case 'manual':
          group = this.manualOverrides[userId] || null;
          break;

        case 'policy_name':
          // API reference confirms policy_name is always "". Check anyway.
          if (webhookObject.policy_name) {
            group = this.policyToGroup[webhookObject.policy_name] || null;
          }
          break;

        default:
          logger.warn(`Resolver: unknown strategy "${strategy}"`);
      }

      if (group) {
        logger.debug(`Resolver: userId=${userId} -> group="${group}" via ${strategy}${userName ? ` (${userName})` : ''}`);
        return { group, strategy, userName };
      }
    }

    logger.debug(`Resolver: no group found for userId=${userId}${userName ? ` (${userName})` : ''}`);
    return { group: null, strategy: null, userName };
  }
}

module.exports = Resolver;
