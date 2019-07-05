'use strict';

import { APIGatewayProxyHandler, APIGatewayProxyEvent } from 'aws-lambda';
import 'source-map-support/register';


import { User, validateLoginRequest, validateTokenRequest, PermissionLevel, checkClassPermissions, validate, ClassObj, getUserByUsername, createUser, addExistingUserToClass, getClassName, hashPassword } from './utility/security';
import { wrapper } from './utility/responses';
import { DynamoDBUpdateParams, performUpdate, DynamoDBPutParams, performPut, updateUser, performScan, DynamoDBScanParams, DynamoDBGetParams, performGet, DynamoDBDeleteParams, performDelete, DynamoDBQueryParams, performQuery } from './utility/database';
import {ErrorTypes, GeneratedError} from './utility/responses';
import { createClassSession, closeClassSession, checkSessionPermissions, checkSessionStatus, getSessionLists, resumeSession } from './utility/sessions';

const randtoken = require('rand-token');

//Checked
export const login: APIGatewayProxyHandler = async (event: APIGatewayProxyEvent):  Promise<any> => {
  return wrapper(async ()=>{
    const query = parseInput(event)
    return await validateLoginRequest(query);
  });
}

//Checked
export const logout: APIGatewayProxyHandler = async (event: APIGatewayProxyEvent):  Promise<any> => {
  return wrapper(async ()=>{
    const query = parseInput(event)
    await validateTokenRequest(query);
    await updateUser(query.id,"SET tokenTime = :t2",{":t2": 0});
  });
}

const addClassToUser = async (userId: string, classId: string) => {
  const addToClass: DynamoDBUpdateParams = {
    TableName: process.env.USER_TABLE,
    Key: {id:userId}, //https://stackoverflow.com/questions/41400538/append-a-new-object-to-a-json-array-in-dynamodb-using-nodejs
    UpdateExpression: 'set #classes = list_append(if_not_exists(#classes, :empty_list), :newClass)',
    ExpressionAttributeNames: {
      '#classes' : 'classes'
    },
    ExpressionAttributeValues: {
      ':empty_list': [],
      ':newClass': [classId]
    }
  }
  await performUpdate(addToClass)
}
//Checked
export const createClass: APIGatewayProxyHandler = async (event: APIGatewayProxyEvent):  Promise<any> => {
  return wrapper(async ()=> {
    const query = parseInput(event)
    await validateTokenRequest(query,true);
    validate(query.className,"string","className",1,50)
    const newClass: ClassObj = {
      id: randtoken.generate(32),
      classUsers: {},
      className: query.className
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

export const deleteClass: APIGatewayProxyHandler = async (event: APIGatewayProxyEvent):  Promise<any> => {
  return wrapper(async ()=> {
    const query = parseInput(event)
    await validateTokenRequest(query);
    await checkClassPermissions(query.id,query.changingClass,PermissionLevel.Professor)
    const getUsers: DynamoDBGetParams = {
      TableName: process.env.CLASS_TABLE,
      Key: {id: query.changingClass},
      ProjectionExpression: 'classUsers'
    }
    const classUsers: ClassObj = await performGet(getUsers)
    //Delete class from users
    await Promise.all(Object.keys(classUsers.classUsers).map(async user => {
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
    //TODO delete all appropriate sessions
    const deleteRequest: DynamoDBDeleteParams = {
      TableName: process.env.CLASS_TABLE,
      Key: {id: query.changingClass}
    }
    await performDelete(deleteRequest)
  });
}
//This is good because professor for class doesn't need to know what other classes a student is in(and shouldn't know)
export const createUpdateClassMembership: APIGatewayProxyHandler = async (event: APIGatewayProxyEvent):  Promise<any> => {
  return wrapper(async ()=> {
    const query = parseInput(event)
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

export const createUpdateAdminStatus: APIGatewayProxyHandler = async (event: APIGatewayProxyEvent):  Promise<any> => {
  return wrapper(async ()=> {
    const query = parseInput(event)
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
  return wrapper(async ()=> {
    const query = parseInput(event)
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
  return wrapper(async ()=> {
    const query = parseInput(event)
    await validateTokenRequest(query);
    await checkClassPermissions(query.id,query.classId,PermissionLevel.Student)
    const request: DynamoDBGetParams  = {
      TableName: process.env.CLASS_TABLE,
      Key: {id: query.classId},
      ProjectionExpression: "classUsers.#givenUser",
      ExpressionAttributeNames: {
        "#givenUser": query.id
      }
    }
    let classInfo = await performGet(request)
    const querySessions: DynamoDBQueryParams = {
      TableName: process.env.SESSION_TABLE,
      IndexName: 'by_class',
      KeyConditionExpression: 'classId = :classId',
      ExpressionAttributeValues: {
        ':classId': query.classId
      },
      ProjectionExpression: 'sessionName, id'
    }
    const sessions =  await performQuery(querySessions);
    classInfo.sessions = sessions;
    return classInfo;
  });
}

type classMap = { [s: string]: number; }

export const getClassAdminInfo: APIGatewayProxyHandler = async (event: APIGatewayProxyEvent): Promise<any> => {
  return wrapper(async ()=> {
    const query = parseInput(event)
    await validateTokenRequest(query);
    await checkClassPermissions(query.id,query.classId,PermissionLevel.Professor)
    const request: DynamoDBGetParams  = {
      TableName: process.env.CLASS_TABLE,
      Key: {id: query.classId},
      ProjectionExpression: "classUsers"
    }
    const {classUsers} : {classUsers: classMap}= await performGet(request)
    const mappedClassUsers = await Promise.all(Object.entries(classUsers).map(async ([user,permissionLevel])=>{
      const userInfoRequest: DynamoDBGetParams = {
        TableName: process.env.USER_TABLE,
        Key: {id: user},
        ProjectionExpression: 'id, username, fullName'
      }
      const result = await performGet(userInfoRequest);
      result.permissionLevel = permissionLevel;
      return result
    }))
    return mappedClassUsers;
  });
}

export const refreshUserInfo: APIGatewayProxyHandler = async (event: APIGatewayProxyEvent): Promise<any> => {
  return wrapper(async ()=> {
    const query = parseInput(event);
    await validateTokenRequest(query);
    const request: DynamoDBGetParams = {
      TableName: process.env.USER_TABLE,
      Key: {id: query.id},
      ProjectionExpression: 'classes, username'
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
  return wrapper(async ()=> {
    const query = parseInput(event);
    await validateTokenRequest(query);
    await validate(query.newUsername,'string', 'newUsername', 1 ,50);
    if(query.newPassword) {
      validate(query.newPassword,'string', 'newPassword', 1);
    }
    const existingUser = await getUserByUsername(query.newUsername,true)
    if(existingUser !== null && existingUser.id !== query.id) {
      throw new GeneratedError(ErrorTypes.UsernameAlreadyExists)
    }
    const request: DynamoDBUpdateParams = {
      TableName: process.env.USER_TABLE,
      Key: {id: query.id},
      UpdateExpression: 'set username = :newUsername' + (query.newPassword ? ', hashedPassword = :newHashedPassword':''),
      ExpressionAttributeValues: {
        ':newUsername': query.newUsername,
      }
    }
    if(query.newPassword) {
      const hashedPassword = await hashPassword(query.newPassword)
      request.ExpressionAttributeValues[':newHashedPassword'] = hashedPassword
    }
    await performUpdate(request)
  })
}

export const setClassName: APIGatewayProxyHandler = async (event: APIGatewayProxyEvent): Promise<any> => {
  return wrapper(async ()=> {
    const query = parseInput(event);
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

export const createSession: APIGatewayProxyHandler = async (event: APIGatewayProxyEvent): Promise<any> => {
  // return wrapper(async ()=> {
  //   const query = parseInput(event);
  //   await validateTokenRequest(query);
  //   await checkClassPermissions(query.id,query.classId,PermissionLevel.Professor)
  //   validate(query.newSessionName,'string','newSessionName',1,50)
  //   await createClassSession(query.classId,query.newSessionName);
  // });
}

export const closeSession: APIGatewayProxyHandler = async (event: APIGatewayProxyEvent): Promise<any> => {
  // return wrapper(async ()=> {
  //   const query = parseInput(event);
  //   await validateTokenRequest(query);
  //   await checkSessionPermissions(query.id,query.sessionId,query.classId,PermissionLevel.Professor)
  //   await closeClassSession(event,query.sessionId);
  // });
}

export const connectionHandler: APIGatewayProxyHandler = async (event, _context): Promise<any> => {
  return
}

export const defaultHandler: APIGatewayProxyHandler = async (event, _context): Promise<any> => {
  return
}


export const joinSession: APIGatewayProxyHandler = async (event, _context): Promise<any> => {
  // return wrapper(async ()=> {
  //   const query = parseInput(event);
  //   await validateTokenRequest(query);
  //   console.log(event)
  //   const status = await checkSessionStatus(query.sessionId, query.id,event.requestContext.connectionId, true)
  //   if(status === null) {
  //     // const status = await checkSessionPermissions(query.id,query.sessionId,query.classId,PermissionLevel.Student)
  //     // result = await joinClassSession(query.sessionId,query.id,status)
  //     await checkSessionPermissions(query.id,query.sessionId,query.classId,PermissionLevel.Student)
  //     await 
  //     return await getSessionLists(query.sessionId);
  //   } else {
  //     return await resumeSession(query.sessionId, query.id, query.connectionId);
  //   }
  // });
}

export const leaveSession: APIGatewayProxyHandler = async (event, _context): Promise<any> => {
  //TODO remove from session
  //TODO inform all relevant members
}


export const joinList: APIGatewayProxyHandler = async (event, _context): Promise<any> => {
  // return wrapper(async ()=> {
  //   const query = parseInput(event);
  //   await validateTokenRequest(query);
  //   console.log(event)
  //   const status = await checkSessionStatus(query.sessionId, query.id,event.requestContext.connectionId, true)
  //   if(status === null) {
  //     // const status = await checkSessionPermissions(query.id,query.sessionId,query.classId,PermissionLevel.Student)
  //     // result = await joinClassSession(query.sessionId,query.id,status)
  //     await checkSessionPermissions(query.id,query.sessionId,query.classId,PermissionLevel.Student)
  //     return await getSessionLists(query.sessionId);
  //   } else {
  //     return await resumeSession(query.sessionId, query.id, query.connectionId);
  //   }
  // })
  //TODO Inform relevant parties
}

export const leaveList: APIGatewayProxyHandler = async (event, _context): Promise<any> => {
  //TODO check if in list and remove if different
  //Join list
  //Inform relevant parties
}

export const helpFromList: APIGatewayProxyHandler = async (event, _context): Promise<any> => {
  //TODO check if in list and remove if different
  //Join list
  //Inform relevant parties
}

export const getFullList: APIGatewayProxyHandler = async (event, _context): Promise<any> => {
  //TODO check if in list and remove if different
  //Join list
  //Inform relevant parties
}

const parseInput = (event) => {
  try {
    const query = JSON.parse(event.body);
    if(query === null || typeof query !== 'object') {
      throw new GeneratedError(ErrorTypes.InvalidInput);
    }
    return query
  } catch (e) {
    throw new GeneratedError(ErrorTypes.InvalidInput);
  }
}






//Class
//Create Session
//Delete Session
//Create List
//Delete List
//Join List
//  Check all lists for presence
//Leave List
//Each list is independent