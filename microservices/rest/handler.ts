'use strict';

import { APIGatewayProxyHandler, APIGatewayProxyEvent } from 'aws-lambda';
const AWS = require('aws-sdk');
const s3 = new AWS.S3();
import 'source-map-support/register';


import { User, validateLoginRequest, validateTokenRequest, PermissionLevel, checkClassPermissions, validate, ClassObj, getUserByUsername, createUser, addExistingUserToClass, getClassName, validateArray } from './utility/security';
import { wrapper } from './utility/responses';
import { DynamoDBUpdateParams, performUpdate, DynamoDBPutParams, performPut, updateUser, performScan, DynamoDBScanParams, DynamoDBGetParams, performGet, DynamoDBDeleteParams, performDelete} from './utility/database';
import {ErrorTypes, GeneratedError} from './utility/responses';
import { createList, ListWrapper } from './utility/list';
import { addClassToUser } from './utility/general';

const randtoken = require('rand-token');

/*
  Login Wrapper for the Login Function
  All functionality handled through utility/security.ts

  client_code: string
*/
export const login: APIGatewayProxyHandler = async (event: APIGatewayProxyEvent):  Promise<any> => {
  return wrapper(event, false, async query=>{
    return await validateLoginRequest(query);
  });
}

/*
  Logout Function

  id: string
  userToken: string
*/
export const logout: APIGatewayProxyHandler = async (event: APIGatewayProxyEvent):  Promise<any> => {
  return wrapper(event, false, async query=>{
    await validateTokenRequest(query);
    await updateUser(query.id,"SET tokenTime = :t2",{":t2": 0});
  });
}


/*
  Create a new class
  Used by site adiministrators

  This function creates a new class, and then adds the creating user to the class as a class administrator

  id: string
  userToken: string
  className: string  1-50 characters
*/
export const createClass: APIGatewayProxyHandler = async (event: APIGatewayProxyEvent):  Promise<any> => {
  return wrapper(event, false, async query=> {
    await validateTokenRequest(query,true);
    validate(query.className,"string","className",1,50)
    const newClass: ClassObj = {
      id: randtoken.generate(32),
      classUsers: {},
      className: query.className,
      userCode: randtoken.generate(10),
      taCode: randtoken.generate(10),
      adminCode: randtoken.generate(10),
      sessions: {},
      remoteMode: false
    }
    newClass.classUsers[query.id] = PermissionLevel.Professor
    const createClassQuery: DynamoDBPutParams = {
      TableName: process.env.CLASS_TABLE,
      Item: newClass
    }
    await performPut(createClassQuery)
    await addClassToUser(query.id,newClass.id)
  });
}
/*
  This deletes a class
  Used by class administrators

  This function is complex, as it must deconstruct every part of the class. First, it removes the class from
  the users' profiles, preventing any new commands from being run. It then deletes the actual class.

  TODO delete all active sessions
  TODO prevent race condition with other administrators performing actions

  id: string
  userToken: string
  changingClass: string

*/
export const deleteClass: APIGatewayProxyHandler = async (event: APIGatewayProxyEvent):  Promise<any> => {
  return wrapper(event, false, async query=> {
    await validateTokenRequest(query);
    await checkClassPermissions(query.id,query.changingClass,PermissionLevel.Professor)
    const getUsers: DynamoDBGetParams = {
      TableName: process.env.CLASS_TABLE,
      Key: {id: query.changingClass},
      ProjectionExpression: 'classUsers, sessions'
    }
    const classUsersAndSessions: ClassObj = await performGet(getUsers)
    //Delete class from users
    await Promise.all(Object.keys(classUsersAndSessions.classUsers).map(async user => {
      //Copied from createUpdateClassMembership consolodate
      const getRemovedUser: DynamoDBGetParams = {
        TableName: process.env.USER_TABLE,
        Key: {id: user},
        ProjectionExpression: 'classes'
      }
      //https://hackernoon.com/safe-list-updates-with-dynamodb-adc44f2e7d3
      const oldClasses = await performGet(getRemovedUser)
      const indexToRemove = oldClasses.classes.indexOf(query.changingClass)
      const removeClassEnrollment: DynamoDBUpdateParams = {
        TableName: process.env.USER_TABLE,
        Key: {id:user},
        UpdateExpression: `remove classes[${indexToRemove}]`,
        ConditionExpression: `classes[${indexToRemove}] = :valueToRemove`,
        ExpressionAttributeValues: {
          ':valueToRemove': query.changingClass
        }
      }
      await performUpdate(removeClassEnrollment)
    }));
    //Close all active sessions
    await Promise.all(Object.values(classUsersAndSessions.sessions).map(async (session)=>{
      await Promise.all(Object.keys(session.lists).map(async list_name => {
        const list = new ListWrapper(list_name)
        await list.closeList(event)
      }));
    }));

    const deleteRequest: DynamoDBDeleteParams = {
      TableName: process.env.CLASS_TABLE,
      Key: {id: query.changingClass}
    }
    await performDelete(deleteRequest)
  });
}
/*
  This adds a (potentially non-existant) user to a class, updates that user's status, or removes them.
  Requires class admin access

  This function adds a user to a class, updates a status, or removes them. If adding a user and the user
  already exists, it simply updates their status, else it creates an entirely new user and then adds that
  new user to the class. This is done so that class administrators cannot determine if a potential user
  already exists on the site, and therefore is part of another class. 

  id: string
  userToken: string
  changingClass: string
  removeUser: boolean
  subjectUsername: string 1-50 characters
  newPermissionLevel?: number - PermissionLevel
  subjectName?: string

*/
export const createUpdateClassMembership: APIGatewayProxyHandler = async (event: APIGatewayProxyEvent):  Promise<any> => {
  return wrapper(event, false, async query=> {
    await validateTokenRequest(query);
    validate(query.changingClass,'string','changingClass',32,32)
    validate(query.removeUser,'boolean','removeUser')
    validate(query.subjectUsername,"string","subjectUsername",1,50)
    await checkClassPermissions(query.id,query.changingClass,PermissionLevel.Professor)
    let existingUser: User = await getUserByUsername(query.subjectUsername,true)
    if(existingUser && !existingUser.classes.includes(query.changingClass) && query.removeUser) {
      throw new GeneratedError(ErrorTypes.UserNotInClass);
    }
    if(existingUser === null) {
      validate(query.newPermissionLevel,'number','newPermissionLevel',PermissionLevel.Student,PermissionLevel.Professor)
      validate(query.subjectName,"string","subjectName",1,100)
      await createUser(query.subjectUsername,false,query.subjectName,query.changingClass,query.newPermissionLevel)
    } else {
      if(query.removeUser) {
        const getRemovedUser: DynamoDBGetParams = {
          TableName: process.env.USER_TABLE,
          Key: {id: existingUser.id},
          ProjectionExpression: 'classes'
        }
        //https://hackernoon.com/safe-list-updates-with-dynamodb-adc44f2e7d3
        const oldClasses = await performGet(getRemovedUser)
        const indexToRemove = oldClasses.classes.indexOf(query.changingClass)
        const removeClassEnrollment: DynamoDBUpdateParams = {
          TableName: process.env.USER_TABLE,
          Key: {id:existingUser.id},
          UpdateExpression: `remove classes[${indexToRemove}]`,
          ConditionExpression: `classes[${indexToRemove}] = :valueToRemove`,
          ExpressionAttributeValues: {
            ':valueToRemove': query.changingClass
          }
        }
        await performUpdate(removeClassEnrollment)
        const removeUserEnrollment: DynamoDBUpdateParams = {
          TableName: process.env.CLASS_TABLE,
          Key: {id:query.changingClass},
          UpdateExpression: `remove classUsers.#existingId`,
          ExpressionAttributeNames: {
            '#existingId': existingUser.id
          }
        }
        await performUpdate(removeUserEnrollment)
      } else {
        validate(query.newPermissionLevel,'number','newPermissionLevel',PermissionLevel.Student,PermissionLevel.Professor)
        if(!existingUser.classes.includes(query.changingClass)) { //Only add class to user if doesn't exist, else permissions may just be changing
          await addClassToUser(existingUser.id,query.changingClass);
        }
        await addExistingUserToClass(query.changingClass,existingUser.id,query.newPermissionLevel)
      }
    }
  });
}

/*
  This function updates the admin status of a (potentially non-existant) user
  Requires site admin access

  Note that if the user does not exist, but the newAdminStatus is set to false, this will create a user with no
  permission and no class association.

  id: string
  userToken: string
  newAdminStatus: boolean
  subjectUsername: string
  subjectName: string
  
*/
export const createUpdateAdminStatus: APIGatewayProxyHandler = async (event: APIGatewayProxyEvent):  Promise<any> => {
  return wrapper(event, false, async query=> {
    validate(query.newAdminStatus,'boolean','newAdminStatus')
    validate(query.subjectUsername,"string","subjectUsername",1,50)
    await validateTokenRequest(query,true);
    let existingUser: User = await getUserByUsername(query.subjectUsername,true)
    if(existingUser === null) {
      validate(query.subjectName,"string","subjectName",1,100)
      await createUser(query.subjectUsername,query.newAdminStatus,query.subjectName)
    } else {
      await updateUser(existingUser.id,'set admin = :newStatus',{':newStatus': query.newAdminStatus});
    }
  });
}

export const getAdminInfo: APIGatewayProxyHandler = async (event: APIGatewayProxyEvent): Promise<any> => {
  return wrapper(event, false, async query=> {
    await validateTokenRequest(query, true);
    const request: DynamoDBScanParams  = {
      TableName: process.env.USER_TABLE,
      ProjectionExpression: "id, fullName, username",
      FilterExpression: 'admin = :t',
      ExpressionAttributeValues: {
        ":t": true
      }
    }
    let adminUsers: User[] = await performScan(request)
    return adminUsers
  });
}


export const getClassInfo: APIGatewayProxyHandler = async (event: APIGatewayProxyEvent): Promise<any> => {
  return wrapper(event, false, async query=> {
    await validateTokenRequest(query);
    await checkClassPermissions(query.id,query.classId,PermissionLevel.Student)
    const request: DynamoDBGetParams  = {
      TableName: process.env.CLASS_TABLE,
      Key: {id: query.classId},
      ProjectionExpression: "classUsers.#givenUser, sessions, remoteMode, imageID",
      ExpressionAttributeNames: {
        "#givenUser": query.id
      }
    }
    return await performGet(request) as ClassObj
  });
}

export const getClassAdminInfo: APIGatewayProxyHandler = async (event: APIGatewayProxyEvent): Promise<any> => {
  return wrapper(event, false, async query=> {
    await validateTokenRequest(query);
    await checkClassPermissions(query.id,query.classId,PermissionLevel.Professor)
    const request: DynamoDBGetParams  = {
      TableName: process.env.CLASS_TABLE,
      Key: {id: query.classId},
      ProjectionExpression: "classUsers, userCode, taCode, adminCode"
    }
    const result : {classUsers: object, userCode: string, taCode: string, adminCode: string}= await performGet(request);
    result.classUsers = await Promise.all(Object.entries(result.classUsers).map(async ([user,permissionLevel])=>{
      const userInfoRequest: DynamoDBGetParams = {
        TableName: process.env.USER_TABLE,
        Key: {id: user},
        ProjectionExpression: 'id, username, fullName'
      }
      const result = await performGet(userInfoRequest);
      result.permissionLevel = permissionLevel;
      return result
    }))
    return result;
  });
}

export const refreshUserInfo: APIGatewayProxyHandler = async (event: APIGatewayProxyEvent): Promise<any> => {
  return wrapper(event, false, async query=> {
    await validateTokenRequest(query);
    const request: DynamoDBGetParams = {
      TableName: process.env.USER_TABLE,
      Key: {id: query.id},
      ProjectionExpression: 'classes, username, fullName, admin, disableAudioAlerts'
    }
    let result =  await performGet(request)
    //Copied from login function make function to not duplicate
    result.classes = await Promise.all((result.classes as string[]).map(async id=>{
      const className =  await getClassName(id);
      return {id, className}
    }))
    return result
  })
}

export const setUserInfo: APIGatewayProxyHandler = async (event: APIGatewayProxyEvent): Promise<any> => {
  return wrapper(event, false, async query=> {
    await validateTokenRequest(query);
    validate(query.newName,'string','newName',1,50);
    validate(query.newAudioAlerts,'boolean','newAudioAlerts');
    // const existingUser = await getUserByUsername(query.newUsername,true)
    // if(existingUser !== null && existingUser.id !== query.id) {
    //   throw new GeneratedError(ErrorTypes.UsernameAlreadyExists)
    // }
    const request: DynamoDBUpdateParams = {
      TableName: process.env.USER_TABLE,
      Key: {id: query.id},
      UpdateExpression: 'set fullName = :newName, disableAudioAlerts = :newAudioAlerts',
      ExpressionAttributeValues: {
        ':newName': query.newName,
        ':newAudioAlerts': query.newAudioAlerts
      }
    }
    await performUpdate(request)
  })
}

export const setClassName: APIGatewayProxyHandler = async (event: APIGatewayProxyEvent): Promise<any> => {
  return wrapper(event, false, async query=> {
    await validateTokenRequest(query);
    await checkClassPermissions(query.id,query.classId,PermissionLevel.Professor)
    validate(query.newClassName,'string','newClassName',1,50)
    const request: DynamoDBUpdateParams = {
      TableName: process.env.CLASS_TABLE,
      Key: {id: query.classId},
      UpdateExpression: 'set className = :newClassName',
      ExpressionAttributeValues: {
        ':newClassName': query.newClassName
      },
      ReturnValues: 'UPDATED_NEW'
    }
    const result = await performUpdate(request)
    return {className: result.Attributes.className, id: query.classId}
  })
}

export const setRemoteMode: APIGatewayProxyHandler = async (event: APIGatewayProxyEvent): Promise<any> => {
  return wrapper(event, false, async query=> {
    await validateTokenRequest(query);
    await checkClassPermissions(query.id,query.classId,PermissionLevel.Professor)
    validate(query.newRemoteMode,'boolean','newRemoteMode')
    const request: DynamoDBUpdateParams = {
      TableName: process.env.CLASS_TABLE,
      Key: {id: query.classId},
      UpdateExpression: 'set remoteMode = :newRemoteMode',
      ExpressionAttributeValues: {
        ':newRemoteMode': query.newRemoteMode
      },
      ReturnValues: 'UPDATED_NEW'
    }
    const result = await performUpdate(request)
    return {id: query.classId, remoteMode: result.Attributes.remoteMode}
  })
}

export const getDailyImagePostURL: APIGatewayProxyHandler = async (event: APIGatewayProxyEvent): Promise<any> => {
  return wrapper(event, false, async query => {
    await validateTokenRequest(query);
    await checkClassPermissions(query.id,query.classId,PermissionLevel.Professor)
    const newName = query.classId+randtoken.generate(32);
    validate(query.imageType,'string','imageType')
    const request = {
      Bucket: process.env.IMAGE_BUCKET,
      Key: newName,
      ContentType: query.imageType,
      ContentDisposition: 'filename=' + newName +'.png'
    }
    return await new Promise((res,rej)=>{
      s3.getSignedUrl('putObject', request, (err, postURL) => {
        if (err) {
            rej(err)
        } else {
            res({newName, postURL})
        }
      })
    })

  })
}

export const setClassDailyImage: APIGatewayProxyHandler = async (event: APIGatewayProxyEvent): Promise<any> => {
  return wrapper(event, false, async query=> {
    await validateTokenRequest(query);
    await checkClassPermissions(query.id,query.classId,PermissionLevel.Professor)
    validate(query.newClassImage,'string','newClassImage')
    if(query.newClassImage.length === 0) {
      const request: DynamoDBUpdateParams = {
        TableName: process.env.CLASS_TABLE,
        Key: {id: query.classId},
        UpdateExpression: 'remove imageID'
      }
      await performUpdate(request)
      return;
    }
    const request: DynamoDBUpdateParams = {
      TableName: process.env.CLASS_TABLE,
      Key: {id: query.classId},
      UpdateExpression: 'set imageID = :newClassImage',
      ExpressionAttributeValues: {
        ':newClassImage': query.newClassImage
      }
    }
    await performUpdate(request)
  })
}

export const createSession: APIGatewayProxyHandler = async (event: APIGatewayProxyEvent): Promise<any> => {
  return wrapper(event, false, async query=> {
    await validateTokenRequest(query);
    await checkClassPermissions(query.id,query.classId,PermissionLevel.Professor)
    validate(query.newSessionName,'string','newSessionName',1,50)
    validateArray(query.startingLists, 'string', 'startingLists')
    const getClassInfoParams: DynamoDBGetParams = {
      TableName: process.env.CLASS_TABLE,
      Key: {id: query.classId},
      ProjectionExpression: 'className, remoteMode',
    }
    const classInfo = await performGet(getClassInfoParams) as ClassObj
    const newListArray = await Promise.all(query.startingLists.map(async name => {
      const newList = await createList(query.classId,query.id,'List '+name+' in Class '+classInfo.className, classInfo.remoteMode);
      const result = {}
      result[newList.id] = name
      return result
    }))
    //https://stackoverflow.com/questions/27538349/merge-multiple-objects-inside-the-same-array-into-one-object
    const newListObj = newListArray.reduce(((r, c) => Object.assign(r, c)), {})
    const createClassSession: DynamoDBUpdateParams = {
      TableName: process.env.CLASS_TABLE,
      Key: {id: query.classId},
      UpdateExpression: 'set sessions.#sessionId = :defaultLists',
      ExpressionAttributeNames: {
        '#sessionId': randtoken.generate(32)
      },
      ExpressionAttributeValues: {
        ':defaultLists': {sessionName: query.newSessionName, lists: newListObj} //TODO check unique names
      }
    }
    await performUpdate(createClassSession)
  });
}

export const closeSession: APIGatewayProxyHandler = async (event: APIGatewayProxyEvent): Promise<any> => {
  return wrapper(event, false, async query=> {
    await validateTokenRequest(query);
    await checkClassPermissions(query.id,query.classId,PermissionLevel.Professor)
    validate(query.sessionId,'string','sessionId',32,32)
    const getClassInfoParams: DynamoDBGetParams = {
      TableName: process.env.CLASS_TABLE,
      Key: {id: query.classId},
      ProjectionExpression: 'sessions.#sessionId',
      ExpressionAttributeNames: {
        '#sessionId': query.sessionId
      }
    }
    const classInfo = await performGet(getClassInfoParams) as ClassObj
    if(classInfo.sessions[query.sessionId]) {
      await Promise.all(Object.keys(classInfo.sessions[query.sessionId].lists).map(async list_name => {
        const list = new ListWrapper(list_name)
        await list.closeList(event)
      }))
    } else {
      throw new GeneratedError(ErrorTypes.SessionDoesNotExist)
    }
    const removeSessionInfoParams: DynamoDBUpdateParams = {
      TableName: process.env.CLASS_TABLE,
      Key: {id: query.classId},
      UpdateExpression: 'remove sessions.#sessionId',
      ExpressionAttributeNames: {
        '#sessionId': query.sessionId
      }
    }
    await performUpdate(removeSessionInfoParams)
  });
}