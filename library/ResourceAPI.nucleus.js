"use strict";

const Promise = require('bluebird');
const uuid = require('uuid');

const NucleusError = require('./Error.nucleus');
const NucleusResource = require('./Resource.nucleus');

const nucleusValidator = require('./validator.nucleus');

const RESOURCE_ID_BY_TYPE_TABLE_NAME = 'ResourceIDByType';
const WALK_HIERARCHY_METHOD_LIST = [
  'TopNodeDescent',
  'CurrentNodeDescent',
  'CurrentNode'
];

class NucleusResourceAPI {

  /**
   * Creates a resource given its name and an object of its attributes.
   *
   * @Nucleus ActionName CreateResource
   * @Nucleus ActionAlternativeSignature resourceType NucleusResourceModel resourceAttributes originUserID
   * @Nucleus ExtendableActionName `Create${resourceType}`
   * @Nucleus ExtendableEventName `${resourceType}Created`
   * @Nucleus ExtendableAlternativeActionSignature 'resourceType' 'NucleusResourceModel' `${Nucleus.shiftFirstLetterToLowerCase(resourceType)}Attributes` 'originUserID'
   * @Nucleus ExtendableActionArgumentDefault resourceType `${resourceType}` NucleusResourceModel Nucleus.generateResourceModelFromResourceStructureByResourceType(`${resourceType}`)
   *
   * @argument {String} resourceType
   * @argument {Function} NucleusResourceModel
   * @argument {Object} resourceAttributes
   * @argument {String} originUserID
   * @argument {String} [parentNodeType]
   * @argument {String} [parentNodeID]
   *
   * @returns {Promise<{ resource: NucleusResource, resourceAuthorID: String, resourceMemberNodeID: String }>}
   *
   * @throws Will throw an error if the resource type is not a string.
   * @throws Will throw an error if the resource model is not an instance of NucleusResource.
   * @throws Will throw an error if the resource attributes is not an object.
   * @throws Will throw an error if the origin user ID is not a string.
   * @throws Will throw an error if no datastore is passed.
   * @throws Will throw an error if the resource is not conform to the model.
   */
  static async createResource (resourceType, NucleusResourceModel, resourceAttributes, originUserID, parentNodeType, parentNodeID) {
    if (!nucleusValidator.isString(resourceType)) throw new NucleusError.UnexpectedValueTypeNucleusError("The resource type must be a string.");
    if (!nucleusValidator.isFunction(NucleusResourceModel)) throw new NucleusError.UnexpectedValueTypeNucleusError("The Nucleus resource model must be an instance of NucleusResource.");
    if (!nucleusValidator.isObject(resourceAttributes)) throw new NucleusError.UnexpectedValueTypeNucleusError("The resource attributes must be an object.");
    if (!nucleusValidator.isString(originUserID) || nucleusValidator.isEmpty(originUserID)) throw new NucleusError.UnexpectedValueTypeNucleusError("The origin user ID must be a string and can't be undefined.");

    if (!!parentNodeType && !parentNodeID) throw new NucleusError.UndefinedValueNucleusError("The parent node type is expected along with the parent node ID.");

    const { $datastore, $resourceRelationshipDatastore } = this;

    if (nucleusValidator.isEmpty($datastore)) throw new NucleusError.UndefinedContextNucleusError("No datastore is provided.");

    if (!$resourceRelationshipDatastore && (!parentNodeType || !parentNodeID)) throw new NucleusError(`Could not resolve the node which the origin user (${originUserID}) is member of.`);

    {
      const [ parentNode ] = (!!$resourceRelationshipDatastore && (!parentNodeID || !parentNodeType)) ? await $resourceRelationshipDatastore.retrieveObjectOfRelationshipWithSubject(`User-${originUserID}`, 'is-member') : [ { ID: parentNodeID, type: parentNodeType } ];

      if (!nucleusValidator.isEmpty(parentNode) && (!parentNodeType || !parentNodeID)) {
        parentNodeType = parentNode.type;
        parentNodeID = parentNode.ID;
      }

      if ((!parentNodeType || !parentNodeID) && parentNode !== 'SYSTEM') throw new NucleusError(`Could not retrieve the node which the origin user (${originUserID}) is member of.`);

      try {
        const reservedResourceID = resourceAttributes.ID;
        Reflect.deleteProperty(resourceAttributes, 'ID');
        Reflect.deleteProperty(resourceAttributes, 'meta');
        const $resource = new NucleusResourceModel(resourceAttributes, originUserID, reservedResourceID);
        const resourceItemKey = $resource.generateOwnItemKey();

        return Promise.all([
          $datastore.addItemToHashFieldByName(resourceItemKey, $resource),
          $datastore.addItemToSetByName(RESOURCE_ID_BY_TYPE_TABLE_NAME, resourceType, $resource.ID),
        ])
          .then(() => {
            if (!$resourceRelationshipDatastore) return;

            return Promise.all([
              $resourceRelationshipDatastore.createRelationshipBetweenSubjectAndObject(`${resourceType}-${$resource.ID}`, 'is-member', (parentNode === 'SYSTEM') ? 'SYSTEM' : `${parentNodeType}-${parentNodeID}`),
              // I am assuming the type of user... That could be changed eventually.
              $resourceRelationshipDatastore.createRelationshipBetweenSubjectAndObject(`${resourceType}-${$resource.ID}`, 'is-authored', `User-${originUserID}`)
            ]);
          })
          .return({ resource: $resource, resourceAuthorID: originUserID, resourceMemberNodeID: (parentNode === 'SYSTEM') ? 'SYSTEM' : parentNodeID });
      } catch (error) {

        throw new NucleusError(`Could not create ${resourceType} because of an external error: ${error}`, { error });
      }
    }
  }

  /**
   * Removes a resource given its name and ID.
   *
   * @Nucleus ActionName RemoveResourceByID
   * @Nucleus ActionAlternativeSignature resourceType NucleusResourceModel resourceID originUserID
   * @Nucleus ExtendableActionName `Remove${resourceType}ByID`
   * @Nucleus ExtendableEventName `${resourceType}ByIDRemoved`
   * @Nucleus ExtendableAlternativeActionSignature 'resourceType' `${Nucleus.shiftFirstLetterToLowerCase(resourceType)}ID` 'originUserID'
   * @Nucleus ExtendableActionArgumentDefault resourceType `${resourceType}`
   *
   * @argument {String} resourceType
   * @argument {String} resourceID
   * @argument {String} originUserID
   *
   * @returns {Promise<{ resourceID: String }>}
   *
   * @throws Will throw an error if the resource type is not a string.
   * @throws Will throw an error if the resource ID is not a string.
   * @throws Will throw an error if the origin user ID is not a string.
   * @throws Will throw an error if no datastore is passed.
   * @throws Will throw an error if the origin user is not authorized to remove the resource.
   * @throws Will throw an error if the resource does not exist.
   */
  static async removeResourceByID (resourceType, resourceID, originUserID) {
    if (!nucleusValidator.isString(resourceType)) throw new NucleusError.UnexpectedValueTypeNucleusError("The resource type must be a string.");
    if (!nucleusValidator.isString(resourceID)) throw new NucleusError.UnexpectedValueTypeNucleusError("The resource ID must be a string.");
    if (!nucleusValidator.isString(originUserID) || nucleusValidator.isEmpty(originUserID)) throw new NucleusError.UnexpectedValueTypeNucleusError("The origin user ID must be a string and can't be undefined.");

    const { $datastore, $resourceRelationshipDatastore } = this;

    if (nucleusValidator.isEmpty($datastore)) throw new NucleusError.UndefinedContextNucleusError("No datastore is provided.");

    const { canUpdateResource } = await NucleusResourceAPI.verifyThatUserCanUpdateResource.call(this, originUserID, resourceType, resourceID);

    if (!canUpdateResource) throw new NucleusError.UnauthorizedActionNucleusError(`The user ("${originUserID}") is not authorized to remove the ${resourceType} ("${resourceID}")`);

    const resourceItemKey = NucleusResource.generateItemKey(resourceType, resourceID);

    const resourceExists = !!(await $datastore.$$server.existsAsync(resourceItemKey));

    if (!resourceExists) throw new NucleusError.UndefinedContextNucleusError(`The ${resourceType} ("${resourceID}") does not exist.`);

    return Promise.all([
      $datastore.removeItemByName(resourceItemKey),
    ])
      .then(() => {
        if (!$resourceRelationshipDatastore) return;

        return $resourceRelationshipDatastore.removeAllRelationshipsToVector(resourceID);
      })
      .return({ resourceID });
  }

  /**
   * Retrieves a resource given its ID.
   *
   * @Nucleus ActionName RetrieveResourceByID
   * @Nucleus ActionAlternativeSignature resourceType NucleusResourceModel resourceID originUserID
   * @Nucleus ExtendableActionName `Retrieve${resourceType}ByID`
   * @Nucleus ExtendableEventName `${resourceType}ByIDRetrieved`
   * @Nucleus ExtendableAlternativeActionSignature 'resourceType' 'NucleusResourceModel' `${Nucleus.shiftFirstLetterToLowerCase(resourceType)}ID` 'originUserID'
   * @Nucleus ExtendableActionArgumentDefault resourceType `${resourceType}` NucleusResourceModel Nucleus.generateResourceModelFromResourceStructureByResourceType(`${resourceType}`)
   *
   * @argument {String} resourceType
   * @argument {Function} NucleusResourceModel
   * @argument {String} resourceID
   * @argument {String} originUserID
   *
   * @returns {Promise<{ resource: NucleusResource }>}
   *
   * @throws Will throw an error if the resource type is not a string.
   * @throws Will throw an error if the resource model is not an instance of NucleusResource.
   * @throws Will throw an error if the resource ID is not a string.
   * @throws Will throw an error if the origin user ID is not a string.
   * @throws Will throw an error if no datastore is passed.
   * @throws Will throw an error if the origin user is not authorized to retrieve the resource.
   * @throws Will throw an error if the resource does not exist.
   */
  static async retrieveResourceByID (resourceType, NucleusResourceModel, resourceID, originUserID) {
    if (!nucleusValidator.isString(resourceType)) throw new NucleusError.UnexpectedValueTypeNucleusError("The resource type must be a string.");
    if (!nucleusValidator.isFunction(NucleusResourceModel)) throw new NucleusError.UnexpectedValueTypeNucleusError("The Nucleus resource model must be an instance of NucleusResource.");
    if (!nucleusValidator.isString(resourceID)) throw new NucleusError.UnexpectedValueTypeNucleusError("The resource ID must be a string.");
    if (!nucleusValidator.isString(originUserID) || nucleusValidator.isEmpty(originUserID)) throw new NucleusError.UnexpectedValueTypeNucleusError("The origin user ID must be a string and can't be undefined.");

    const { $datastore } = this;

    if (nucleusValidator.isEmpty($datastore)) throw new NucleusError.UndefinedContextNucleusError("No datastore is provided.");

    const { canRetrieveResource } = await NucleusResourceAPI.verifyThatUserCanRetrieveResource.call(this, originUserID, resourceType, resourceID);

    if (!canRetrieveResource) throw new NucleusError.UnauthorizedActionNucleusError(`The user ("${originUserID}") is not authorized to retrieve the ${resourceType} ("${resourceID}")`);

    const resourceItemKey = NucleusResource.generateItemKey(resourceType, resourceID);

    const resourceExists = !!(await $datastore.$$server.existsAsync(resourceItemKey));

    if (!resourceExists) throw new NucleusError.UndefinedContextNucleusError(`The ${resourceType} ("${resourceID}") does not exist.`);

    return $datastore.retrieveAllItemsFromHashByName(resourceItemKey)
      .then((resourceAttributes) => {
        const $resource = new NucleusResourceModel(resourceAttributes, originUserID);

        return { resource: $resource };
      });
  }

  /**
   * Retrieves all the resources given its type.
   * This is done base on the hierarchy of resources and the origin user ID.
   *
   * @argument {String} nodeType
   * @argument {String} originUserID
   * @argument {walkHierarchyTreeMethod} [originUserID]=[TopNodeDescent,CurrentNodeDescent,CurrentNode]
   *
   * @returns {Promise<{ resourceList: Node[] }>}
   */
  static async retrieveAllNodesByType (nodeType, originUserID, walkHierarchyTreeMethod = 'TopNodeDescent') {
    if (!nucleusValidator.isString(walkHierarchyTreeMethod) || !~WALK_HIERARCHY_METHOD_LIST.indexOf(walkHierarchyTreeMethod)) throw new NucleusError.UnexpectedValueTypeNucleusError(`The walk hierarchy method ("${walkHierarchyTreeMethod}") is not a valid method.`);

    const { $resourceRelationshipDatastore } = this;
    const anchorNodeIsList = [];

    switch (walkHierarchyTreeMethod) {
      case 'TopNodeDescent':
      {
        const userAncestorNodeList = await NucleusResourceAPI.walkHierarchyTreeUpward.call(this, `User-${originUserID}`);
        const userDirectAncestorChildrenNodeList = await NucleusResourceAPI.walkHierarchyTreeDownward.call(this, userAncestorNodeList[0]);

        userAncestorNodeList.slice(0).concat(userDirectAncestorChildrenNodeList)
          .forEach(anchorNodeIsList.push.bind(anchorNodeIsList));

      }
        break;

      case 'CurrentNodeDescent':
      {
        const userCurrentNodeList = await await $resourceRelationshipDatastore.retrieveObjectOfRelationshipWithSubject(`User-${originUserID}`, 'is-member');
        const userCurrentNodeChildrenNodeList = await NucleusResourceAPI.walkHierarchyTreeDownward.call(this, userCurrentNodeList[0]);

        userCurrentNodeList.slice(0).concat(userCurrentNodeChildrenNodeList)
          .forEach(anchorNodeIsList.push.bind(anchorNodeIsList));
      }
        break;

      case 'CurrentNodeDescent':
      {
        const userCurrentNodeList = await await $resourceRelationshipDatastore.retrieveObjectOfRelationshipWithSubject(`User-${originUserID}`, 'is-member');

        anchorNodeIsList.push(userCurrentNodeList);
      }
        break;

      default:
        throw new NucleusError.UnexpectedValueNucleusError(`"${walkHierarchyTreeMethod}" is not a valid walking method of the hierarchy tree.`);
    }

    return Promise.all(anchorNodeIsList
      .map(anchorNodeID => $resourceRelationshipDatastore.retrieveAllNodesByTypeForAnchorNode.call(this, nodeType, anchorNodeID, 'is-member', originUserID)))
      .then((childrenNodeListList) => {

        return childrenNodeListList
          .reduce((accumulator, childrenNodeList) => {
            accumulator = accumulator.concat(childrenNodeList);

            return accumulator;
          }, []);
      });
  }

  /**
   * Retrieves all the resources based on its relationship with the object.
   *
   * @argument {String} resourceType
   * @argument {Function} NucleusResourceModel
   * @argument {String} objectResourceID
   * @argument {String} relationshipPredicate
   * @argument {String} originUserID
   *
   * @returns {Promise<{ resourceList: Node[] }>}
   */
  static retrieveAllNodesByRelationshipWithNodeByID (objectNodeType, objectNodeID, relationshipPredicate, originUserID) {
    const { $resourceRelationshipDatastore } = this;

    return $resourceRelationshipDatastore.retrieveSubjectOfRelationshipWithObject(`${objectNodeType}-${objectNodeID}`, relationshipPredicate)
      .then((nodeList) => {

        return Promise.all(nodeList
          .map(async (node) => {
            const { ID: resourceID, type: resourceType } = node;

            const { canRetrieveResource } = await NucleusResourceAPI.verifyThatUserCanRetrieveResource(originUserID, resourceType, resourceID);

            if (!canRetrieveResource) return;

            return node;
          }))
          .then((nodeList) => {

            return nodeList.filter(node => !!node);
          });
      });
  }

  /**
   * Updates a resource given its ID.
   *
   * @Nucleus ActionName RetrieveAllResourcesByType
   * @Nucleus ActionAlternativeSignature resourceType originUserID
   * @Nucleus ExtendableActionName `RetrieveAll${pluralResourceType}`
   * @Nucleus ExtendableEventName `All${pluralResourceType}Retrieved`
   * @Nucleus ExtendableActionArgumentDefault resourceType `${resourceType}` NucleusResourceModel Nucleus.generateResourceModelFromResourceStructureByResourceType(`${resourceType}`)
   *
   * @argument {String} resourceType
   * @argument {Function} NucleusResourceModel
   * @argument {String} originUserID
   * @argument {String} walkHierarchyTreeMethod
   *
   * @returns {Promise<{ resource: NucleusResource }>}
   *
   * @throws Will throw an error if the resource type is not a string.
   * @throws Will throw an error if the origin user ID is not a string.
   * @throws Will throw an error if the walk hierarchy tree method not a string or is not a valid method.
   * @throws Will throw an error if no datastore is passed.
   */
  static retrieveAllResourcesByType (resourceType, NucleusResourceModel, originUserID, walkHierarchyTreeMethod = 'TopNodeDescent') {
    if (!nucleusValidator.isString(resourceType)) throw new NucleusError.UnexpectedValueTypeNucleusError("The resource type must be a string.");
    if (!nucleusValidator.isString(originUserID) || nucleusValidator.isEmpty(originUserID)) throw new NucleusError.UnexpectedValueTypeNucleusError("The origin user ID must be a string and can't be undefined.");

    return NucleusResourceAPI.retrieveAllNodesByType(resourceType, originUserID, walkHierarchyTreeMethod)
      .then((nodeList) => {

        return Promise.all(nodeList
          .map(({ ID: nodeID, type: nodeType }) => {

            return NucleusResourceAPI.retrieveResourceByID(nodeType, NucleusResourceModel, nodeID, originUserID);
          }));
      });
  }

  /**
   * Updates a resource given its ID.
   *
   * @Nucleus ActionName UpdateResourceByID
   * @Nucleus ActionAlternativeSignature resourceType NucleusResourceModel resourceID resourceAttributes originUserID
   * @Nucleus ExtendableActionName `Update${resourceType}ByID`
   * @Nucleus ExtendableEventName `${resourceType}ByIDUpdated`
   * @Nucleus ExtendableAlternativeActionSignature 'resourceType' 'NucleusResourceModel' `${Nucleus.shiftFirstLetterToLowerCase(resourceType)}ID` `${Nucleus.shiftFirstLetterToLowerCase(resourceType)}Attributes` 'originUserID'
   * @Nucleus ExtendableActionArgumentDefault resourceType `${resourceType}` NucleusResourceModel Nucleus.generateResourceModelFromResourceStructureByResourceType(`${resourceType}`)
   *
   * @argument {String} resourceType
   * @argument {Function} NucleusResourceModel
   * @argument {String} resourceID
   * @argument {Object} resourceAttributes
   * @argument {String} originUserID
   *
   * @returns {Promise<{ resource: NucleusResource }>}
   *
   * @throws Will throw an error if the resource type is not a string.
   * @throws Will throw an error if the resource model is not an instance of NucleusResource.
   * @throws Will throw an error if the resource ID is not a string.
   * @throws Will throw an error if the resource attributes is not an object.
   * @throws Will throw an error if the origin user ID is not a string.
   * @throws Will throw an error if no datastore is passed.
   * @throws Will throw an error if the origin user is not authorized to retrieve the resource.
   * @throws Will throw an error if the resource does not exist.
   */
  static async updatesResourceByID (resourceType, NucleusResourceModel, resourceID, resourceAttributes, originUserID) {
    if (!nucleusValidator.isString(resourceType)) throw new NucleusError.UnexpectedValueTypeNucleusError("The resource type must be a string.");
    if (!nucleusValidator.isFunction(NucleusResourceModel)) throw new NucleusError.UnexpectedValueTypeNucleusError("The Nucleus resource model must be an instance of NucleusResource.");
    if (!nucleusValidator.isString(resourceID)) throw new NucleusError.UnexpectedValueTypeNucleusError("The resource ID must be a string.");
    if (!nucleusValidator.isObject(resourceAttributes)) throw new NucleusError.UnexpectedValueTypeNucleusError("The resource attributes must be an object.");
    if (!nucleusValidator.isString(originUserID) || nucleusValidator.isEmpty(originUserID)) throw new NucleusError.UnexpectedValueTypeNucleusError("The origin user ID must be a string and can't be undefined.");

    const { $datastore } = this;

    if (nucleusValidator.isEmpty($datastore)) throw new NucleusError.UndefinedContextNucleusError("No datastore is provided.");

    const { canUpdateResource } = await NucleusResourceAPI.verifyThatUserCanUpdateResource.call(this, originUserID, resourceType, resourceID);

    if (!canUpdateResource) throw new NucleusError.UnauthorizedActionNucleusError(`The user ("${originUserID}") is not authorized to update the ${resourceType} ("${resourceID}")`);

    const resourceItemKey = NucleusResource.generateItemKey(resourceType, resourceID);

    const resourceExists = !!(await $datastore.$$server.existsAsync(resourceItemKey));

    if (!resourceExists) throw new NucleusError.UndefinedContextNucleusError(`The ${resourceType} ("${resourceID}") does not exist.`);

    return $datastore.retrieveAllItemsFromHashByName(resourceItemKey)
      .then((staleResourceAttributes) => {
        const updatedISOTime = new Date().toISOString();
        staleResourceAttributes.meta = Object.assign({ updatedISOTime }, staleResourceAttributes.meta);

        Reflect.deleteProperty(resourceAttributes, 'ID');
        Reflect.deleteProperty(resourceAttributes, 'meta');

        const $resource = new NucleusResourceModel(Object.assign({}, staleResourceAttributes, resourceAttributes), originUserID);

        $resource.meta.updatedISOTime = new Date().toISOString();

        return $datastore.addItemToHashFieldByName(resourceItemKey, Object.assign({}, { meta: $resource.meta }, resourceAttributes))
          .return({ resource: $resource });
      });
  }

  /**
   * @typedef {Object} Node - Represents a node in a hierarchy tree.
   * @property {String} ID
   * @property {String} type
   */

  /**
   * Verifies that the user can retrieve a given resource based on the hierarchy.
   *
   * @argument userID
   * @argument resourceID
   *
   * @returns {Promise<{ canRetrieveResource: Boolean }>}
   */
  static async verifyThatUserCanRetrieveResource (userID, resourceType, resourceID) {
    const { $resourceRelationshipDatastore } = this;

    if (!$resourceRelationshipDatastore) return { canRetrieveResource: true };

    const userAncestorNodeList = await NucleusResourceAPI.walkHierarchyTreeUpward.call(this, `User-${userID}`);
    const userDirectAncestorChildrenNodeList = await NucleusResourceAPI.walkHierarchyTreeDownward.call(this, userAncestorNodeList[0]);
    const resourceAncestorNodeList = await NucleusResourceAPI.walkHierarchyTreeUpward.call(this, `${resourceType}-${resourceID}`);

    const nodeIDIntersectionList = userAncestorNodeList.slice(0).concat(userDirectAncestorChildrenNodeList)
      .filter((node) => {

        return resourceAncestorNodeList
          .reduce((accumulator, ancestorNode) => {
            if (ancestorNode.ID === node.ID) accumulator.push(node);

            return accumulator;
          }, []).length > 0;
      });

    if (nodeIDIntersectionList.length === 0) return { canRetrieveResource: false };

    return { canRetrieveResource: true };
  }

  /**
   * Verifies that the user can update a given resource based on the hierarchy.
   *
   * @argument userID
   * @argument resourceID
   *
   * @returns {Promise<{ canUpdateResource: Boolean }>}
   */
  static async verifyThatUserCanUpdateResource (userID, resourceType, resourceID) {
    const { $resourceRelationshipDatastore } = this;

    if (!$resourceRelationshipDatastore) return { canUpdateResource: true };

    const userDirectAncestorNodeList = await $resourceRelationshipDatastore.retrieveObjectOfRelationshipWithSubject(`User-${userID}`, 'is-member');
    const userDirectAncestorChildrenNodeList = await NucleusResourceAPI.walkHierarchyTreeDownward.call(this, userDirectAncestorNodeList[0]);
    const resourceAncestorNodeList = await NucleusResourceAPI.walkHierarchyTreeUpward.call(this, `${resourceType}-${resourceID}`);

    const nodeIDIntersectionList = userDirectAncestorNodeList.slice(0).concat(userDirectAncestorChildrenNodeList)
      .filter((node) => {

        return resourceAncestorNodeList
          .reduce((accumulator, ancestorNode) => {
            if (ancestorNode.ID === node.ID) accumulator.push(node);

            return accumulator;
          }, []).length > 0;
      });

    if (nodeIDIntersectionList.length === 0) return { canUpdateResource: false };

    return { canUpdateResource: true };
  }

  /**
   * Recursively walks down all the branches of a given resource and collect every children.
   *
   * @argument {String} resourceID
   * @argument {Number} [depth=Infinity]
   *
   * @returns {Promise<String[]>}
   */
  static async walkHierarchyTreeDownward (nodeID, depth = Infinity) {
    const { $resourceRelationshipDatastore } = this;

    if (!$resourceRelationshipDatastore) return [];

    const nodeList = [];
    const nodeIDList = [];

    async function retrieveAncestorForNodeByID (nodeID) {
      const childrenNodeList = await $resourceRelationshipDatastore.retrieveSubjectOfRelationshipWithObject(nodeID, 'is-member');

      if (childrenNodeList.length === 0 || !!~childrenNodeList.indexOf('SYSTEM')) return null;

      childrenNodeList
        .forEach((node) => {
          const { ID: nodeID } = node;

          if (!~nodeIDList.indexOf(nodeID)) {
            nodeList.push(node);
            nodeIDList.push(nodeID);
          }
        }, nodeList);

      if (nodeList.length >= depth) return;

      return Promise.all(childrenNodeList
        .map(retrieveAncestorForNodeByID.bind(this)));
    }

    return new Promise(async (resolve) => {
      await retrieveAncestorForNodeByID.call(this, nodeID);

      resolve(nodeList);
    });
  }

  /**
   * Recursively walks up all the branches of a given resource and collect every ancestors.
   *
   * @argument {String} nodeID
   * @argument {Number} [depth=Infinity]
   *
   * @returns {Promise<Node[]>}
   */
  static async walkHierarchyTreeUpward (nodeID, depth = Infinity) {
    const { $resourceRelationshipDatastore } = this;

    const nodeList = [];
    const nodeIDList = [];

    async function retrieveAncestorForNodeByID (nodeID) {
      const ancestorNodeList = await $resourceRelationshipDatastore.retrieveObjectOfRelationshipWithSubject(nodeID, 'is-member');

      if (ancestorNodeList.length === 0 || !!~ancestorNodeList.indexOf('SYSTEM')) return null;

      ancestorNodeList
        .forEach((node) => {
          const { ID: nodeID } = node;

          if (!~nodeIDList.indexOf(nodeID)) {
            nodeList.push(node);
            nodeIDList.push(nodeID);
          }
        }, nodeList);

      if (nodeList.length >= depth) return;

      return Promise.all(ancestorNodeList
        .map(retrieveAncestorForNodeByID.bind(this)));
    }

    return new Promise(async (resolve) => {
      await retrieveAncestorForNodeByID.call(this, nodeID);

      resolve(nodeList);
    });
  }
}

module.exports = NucleusResourceAPI;