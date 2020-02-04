import { DynamoDBGetParams, performGet, DynamoDBUpdateParams, performUpdate } from "./database";
import { ClassObj } from "./security";
import { createList, ListWrapper } from "./list";
import { randtoken } from "../handler";
import { ErrorTypes, GeneratedError } from "./responses";
import { APIGatewayEvent } from "aws-lambda";

export interface DatabaseScheduledEvent {
    id: string,
    startDay: number,
    startHour: number,
    startMinute: number,
    endDay: number,
    endHour: number,
    endMinute: number,
    sessionName: string,
    classId: string,
    sessionId?: string,
    startingLists: string[],
    creatorId: string
}


export const scheduleEvent = async (input: DatabaseScheduledEvent) => {
    //Code copied from handler TODO merge
    const getClassInfoParams: DynamoDBGetParams = {
        TableName: process.env.CLASS_TABLE,
        Key: {id: input.classId},
        ProjectionExpression: 'className',
    }
    const classInfo = await performGet(getClassInfoParams) as ClassObj
    const newListArray = await Promise.all(input.startingLists.map(async name => {
        const newList = await createList(input.classId,input.creatorId,'List '+name+' in Class '+classInfo.className);
        const result = {}
        result[newList.id] = name
        return result
    }))
    //https://stackoverflow.com/questions/27538349/merge-multiple-objects-inside-the-same-array-into-one-object
    const newListObj = newListArray.reduce(((r, c) => Object.assign(r, c)), {})
    const newSessionId = randtoken.generate(32)
    const createClassSession: DynamoDBUpdateParams = {
      TableName: process.env.CLASS_TABLE,
      Key: {id: input.classId},
      UpdateExpression: 'set sessions.#sessionId = :defaultLists',
      ExpressionAttributeNames: {
          '#sessionId': newSessionId
      },
      ExpressionAttributeValues: {
          ':defaultLists': {sessionName: input.sessionName, lists: newListObj} //TODO check unique names
      }
    }
    await performUpdate(createClassSession)
    const updateSchedule: DynamoDBUpdateParams = {
      TableName: process.env.SCHEDULE_TABLE,
      Key: {id: input.id},
      UpdateExpression: 'set sessionId = :newId',
      ExpressionAttributeValues: {
        ':newId': newSessionId
      }
    }
    await performUpdate(updateSchedule)
}

export const closeScheduledSession = async (input: DatabaseScheduledEvent, event: APIGatewayEvent) => {
    //Delete from item as well
    const removeFromSession: DynamoDBUpdateParams = {
        TableName: process.env.SCHEDULE_TABLE,
        Key: {id: input.id},
        UpdateExpression: 'remove sessionId'
    }
    await performUpdate(removeFromSession);
    //TODO copied from handler todo merge
    const getClassInfoParams: DynamoDBGetParams = {
        TableName: process.env.CLASS_TABLE,
        Key: {id: input.classId},
        ProjectionExpression: 'sessions.#sessionId',
        ExpressionAttributeNames: {
          '#sessionId': input.sessionId
        }
      }
      const classInfo = await performGet(getClassInfoParams) as ClassObj
      if(classInfo.sessions[input.sessionId]) {
        await Promise.all(Object.keys(classInfo.sessions[input.sessionId].lists).map(async list_name => {
          const list = new ListWrapper(list_name)
          await list.closeList(event)
        }))
      } else {
        throw new GeneratedError(ErrorTypes.SessionDoesNotExist)
      }
      const removeSessionInfoParams: DynamoDBUpdateParams = {
        TableName: process.env.CLASS_TABLE,
        Key: {id: input.classId},
        UpdateExpression: 'remove sessions.#sessionId',
        ExpressionAttributeNames: {
          '#sessionId': input.sessionId
        }
      }
      await performUpdate(removeSessionInfoParams)
      
}