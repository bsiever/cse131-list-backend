'use strict';

import { APIGatewayProxyHandler} from 'aws-lambda';
import 'source-map-support/register';


import { validateTokenRequest, PermissionLevel, checkClassPermissions, validate, ClassObj, addExistingUserToClass, validateArray } from './utility/security';
import { wrapper } from './utility/responses';
import { DynamoDBUpdateParams, performUpdate, DynamoDBPutParams, performPut, performScan, DynamoDBScanParams, DynamoDBGetParams, performGet, DynamoDBDeleteParams, performDelete, DynamoDBQueryParams, performQuery} from './utility/database';
import {ErrorTypes, GeneratedError} from './utility/responses';
import { ListWrapper } from './utility/list';
import { sendMessageToUser, WebSocketMessages } from './utility/websocket';
import { DatabaseScheduledEvent, scheduleEvent, closeScheduledSession } from './utility/scheduledEvent';
import { addClassToUser } from './utility/general';

export const randtoken = require('rand-token');


export const helpNextUser: APIGatewayProxyHandler = async (event, _context): Promise<any> => {
  return wrapper(event, true, async query=> {
    await validateTokenRequest(query);
    const list = new ListWrapper(query.list_id)
    let positionInfo = (await list.getIndexOfUser(query.id));
    if(positionInfo.index !== -1) {
      await list.helpUser(query.id,0,event) //Gets first user
    } else {
      throw new GeneratedError(ErrorTypes.ConnectionNotInSession)
    }
  });
}

export const joinList: APIGatewayProxyHandler = async (event, _context): Promise<any> => {
    return wrapper(event, true, async query=> {
      await validateTokenRequest(query);
      validate(query.remoteURL,'string','remoteURL',0,200);
      const list = new ListWrapper(query.list_id)
      let positionInfo;
      try {
        positionInfo = (await list.getIndexOfUser(query.id));
      } catch {
        //In cases of failure, IE list doesn't exist as it has been closed
        await sendMessageToUser(query.id, event.requestContext.connectionId, '',WebSocketMessages.CloseListSession,event,list);   
        return;
      }
      if(positionInfo.index !== -1) {
        Object.assign(positionInfo, await list.updateConnectionForUser(query.id,event.requestContext.connectionId,query.remoteURL));
      } else {
        positionInfo = await list.addUser(query.id,event.requestContext.connectionId, query.remoteURL, event);
      }
      await sendMessageToUser(query.id, event.requestContext.connectionId, positionInfo,WebSocketMessages.InitalizeSession,event,list);   
    });
}

export const leaveList: APIGatewayProxyHandler = async (event, _context): Promise<any> => {
  return wrapper(event, true, async query=> {
    await validateTokenRequest(query);
    const list = new ListWrapper(query.list_id)
    await list.removeUserFromList(query.id, event);
  });
}

export const flagUser: APIGatewayProxyHandler = async (event, _context): Promise<any> => {
  return wrapper(event, true, async query=> {
    await validateTokenRequest(query);
    const list = new ListWrapper(query.list_id)
    await list.flagUser(query.id, query.studentName, query.message, event);
  });
}

export const helpFlaggedUser: APIGatewayProxyHandler = async (event, _context): Promise<any> => {
  return wrapper(event, true, async query=> {
    await validateTokenRequest(query);
    const list = new ListWrapper(query.list_id)
    await list.helpFlagUser(query.id, query.studentName, query.message, event);
  });
}

export const selfAddClass: APIGatewayProxyHandler = async (event, _context): Promise<any> => {
  return wrapper(event, false, async query=> {
    await validateTokenRequest(query);
    validate(query.classCode,'string','classCode',10,10)
    const request: DynamoDBScanParams  = {
      TableName: process.env.CLASS_TABLE,
      ProjectionExpression: "id, userCode, taCode, adminCode",
      FilterExpression: 'userCode = :t or taCode = :t or adminCode = :t',
      ExpressionAttributeValues: {
        ":t": query.classCode
      }
    }
    let classes: ClassObj[] = await performScan(request);
    if(classes.length === 0) {
      throw new GeneratedError(ErrorTypes.InvalidInput);
    }
    let givenClass = classes[0];
    const newPermissionLevel: PermissionLevel = givenClass.userCode === query.classCode ? PermissionLevel.Student : givenClass.taCode === query.classCode ? PermissionLevel.TA : givenClass.adminCode === query.classCode ? PermissionLevel.Professor : -1;
    const userParams: DynamoDBGetParams = {
      TableName: process.env.USER_TABLE,
      Key: {id: query.id},
      ProjectionExpression: "classes"
    };
    const existingUser = await performGet(userParams);
    if(existingUser && existingUser.classes.includes(givenClass.id)) {
      throw new GeneratedError(ErrorTypes.UserAlreadyInClass);
    }
    await addExistingUserToClass(givenClass.id,query.id,newPermissionLevel);
    await addClassToUser(query.id,givenClass.id);
  });
}

export const getFullOverview: APIGatewayProxyHandler = async (event, _context): Promise<any> => {
  return wrapper(event, true, async query=> {
    await validateTokenRequest(query);
    const list = new ListWrapper(query.list_id)
    await list.getFullOverview(query.id, event);
  });
}

/*Scheduled function(s)*/

const daysOfWeek = {Sunday: 0, Monday: 1, Tuesday: 2, Wednesday: 3, Thursday: 4, Friday: 5, Saturday: 6};
const offset = 5; //Minutes between call assumes, always less than 60

export const startStopScheduledSessions: APIGatewayProxyHandler = async (event, _context): Promise<any> => {
  const getAllScheduledEvents: DynamoDBScanParams = {
    TableName: process.env.SCHEDULE_TABLE
  } as DynamoDBScanParams //Force conversion to allow no filters
  const scheduledEvents: DatabaseScheduledEvent[] = await performScan(getAllScheduledEvents);
  const date = new Date();
  const dayOfWeek = date.toLocaleString("en-US", {timeZone: "America/Chicago", weekday: 'long'});
  
  const day: number = daysOfWeek[dayOfWeek];
  const hour:number = Number(date.toLocaleString("en-US", {timeZone: "America/Chicago", hour: '2-digit',hour12: false}).substring(0,2));
  const minute: number = Number(date.toLocaleString("en-US", {timeZone: "America/Chicago", minute: '2-digit',hour12: false}).substring(0,2));
  for(let e of scheduledEvents) {
    
    try { //Handle errors without crashing function
      //Check if need to be scheduled
      //Handle case when start in same day
      if(day == e.startDay) {
        //End in next day
        if(hour == 23 && minute+offset>=60 && e.startHour == 23 && e.startMinute >= minute) {
          await scheduleEvent(e);
        } else if((hour< e.startHour || (hour==e.startHour && minute<=e.startMinute)) && ((hour==e.startHour-1 && (minute +offset - 60 > e.startMinute))|| (hour==e.startHour && (minute+offset > e.startMinute)))) { //Make sure end after schedule
          await scheduleEvent(e);
        }
      }
      //Case where currently in previous day
      if((day+1==7?0:day+1) == e.startDay && hour==23 && minute + offset >= 60) {
        if(e.startHour == 0 && e.startMinute < offset + minute - 60) {
          await scheduleEvent(e);
        }
      }
      //Check if need to be closed
      if(e.sessionId) {
        //In next day, know end time has passed, close
        if(e.endDay+1==7?0:day+1 == day && hour==23 && minute + offset >= 60) {
          await closeScheduledSession(e,event);
        }
        if(day == e.endDay) {
          if(e.endHour < hour || (e.endHour==hour && e.endMinute < minute)) {
            await closeScheduledSession(e,event);
          }
        }
      }
    } catch(e) {
      console.log("ERROR: ");
      console.log(e);
    }
  }
}

export const addScheduledSession: APIGatewayProxyHandler = async (event, _context): Promise<any> => {
  return wrapper(event, false, async query=> {
    await validateTokenRequest(query);
    await checkClassPermissions(query.id,query.classId,PermissionLevel.Professor)
    validate(query.day,'number','day',0,6)
    validate(query.hour,'number','hour',0,23)
    validate(query.minute,'number','minute',0,59)
    validate(query.endDay,'number','endDay',0,6)
    validate(query.endHour,'number','endHour',0,23)
    validate(query.endMinute,'number','endMinute',0,59)
    validate(query.sessionName,'string','sessionName',1,50)
    validateArray(query.startingLists, 'string', 'startingLists')
    
    const input: DatabaseScheduledEvent = {
      startDay: query.day,
      startHour: query.hour,
      startMinute: query.minute,
      endDay: query.endDay,
      endHour: query.endHour,
      endMinute: query.endMinute,
      sessionName: query.sessionName,
      classId: query.classId,
      startingLists: query.startingLists,
      creatorId: query.id,
      id: randtoken.generate(32)
    } 
    const createSchedule: DynamoDBPutParams = {
      TableName: process.env.SCHEDULE_TABLE,
      Item: input
    }
    await performPut(createSchedule);
  });
}

export const updateScheduledSession: APIGatewayProxyHandler = async (event, _context): Promise<any> => {
  return wrapper(event, false, async query=> {
    await validateTokenRequest(query);
    await checkClassPermissions(query.id,query.classId,PermissionLevel.Professor)
    validate(query.scheduleId, 'string','scheduleId',32,32);
    validate(query.day,'number','day',0,6)
    validate(query.hour,'number','hour',0,23)
    validate(query.minute,'number','minute',0,59)
    validate(query.endDay,'number','endDay',0,6)
    validate(query.endHour,'number','endHour',0,23)
    validate(query.endMinute,'number','endMinute',0,59)
    validate(query.sessionName,'string','sessionName',1,50)
    validateArray(query.startingLists, 'string','startingLists')
    //Note not doing starting lists now as not needed, easy to add
    const updateScheduleParams: DynamoDBUpdateParams = {
      TableName: process.env.SCHEDULE_TABLE,
      Key: {id: query.scheduleId},
      ConditionExpression: 'classId = :givenClassId',
      ExpressionAttributeValues: {
        ':givenClassId': query.classId,
        ':newSessionName': query.sessionName,
        ':newHour': query.hour,
        ':newMinute': query.minute,
        ':newDay': query.day,
        ':newEndHour': query.endHour,
        ':newEndMinute': query.endMinute,
        ':newEndDay': query.endDay,
        ':newStartingLists': query.startingLists
      },
      UpdateExpression: 'set startingLists = :newStartingLists, sessionName = :newSessionName, startHour = :newHour, startMinute = :newMinute, startDay = :newDay, endHour = :newEndHour, endMinute = :newEndMinute, endDay = :newEndDay',
    }
    await performUpdate(updateScheduleParams)
  })
}
export const removeScheduledSession: APIGatewayProxyHandler = async (event, _context): Promise<any> => {
  return wrapper(event, false, async query=> {
    await validateTokenRequest(query);
    await checkClassPermissions(query.id,query.classId,PermissionLevel.Professor)
    validate(query.scheduleId, 'string','scheduleId',32,32);
    const deleteSchedule: DynamoDBDeleteParams = {
      TableName: process.env.SCHEDULE_TABLE,
      Key: {id: query.scheduleId},
      ConditionExpression: 'classId = :givenClassId',
      ExpressionAttributeValues: {
        ':givenClassId': query.classId
      }
    }
    await performDelete(deleteSchedule);
  })
}

export const getScheduleForClass: APIGatewayProxyHandler = async (event, _context): Promise<any> => {
  return wrapper(event, false, async query=> {
    await validateTokenRequest(query);
    await checkClassPermissions(query.id,query.classId,PermissionLevel.Professor)
    const getSessions: DynamoDBQueryParams = {
      TableName: process.env.SCHEDULE_TABLE,
      IndexName: 'by_class_id',
      KeyConditionExpression: 'classId = :givenClassId',
      ExpressionAttributeValues: {
        ':givenClassId': query.classId
      }
    }
    return await performQuery(getSessions);
  })
}